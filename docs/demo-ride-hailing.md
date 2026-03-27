# Demo: Ride-Hailing Trip Coordinator

**Implementation language: Go** — this demo is the first application built on `runtime-go`, exercising both the new Go runtime and Phase 4's machine invocation feature together.

## Why This Domain

Every ride-hailing company (Uber, Lyft, Grab, Bolt, DiDi) builds their trip coordination state machine from scratch. There is no off-the-shelf "trip orchestration engine." Stripe moves money. Google Maps provides routing. Twilio sends texts. But nothing orchestrates the stateful workflow of matching a rider with a driver, managing the trip lifecycle, handling the dozen ways a trip can go sideways, and settling payment correctly at the end.

This matters because:
- **No "just use X" response** — nobody sells ride-hailing orchestration as a service. Every company writes custom code.
- **Everyone understands it** — every developer has taken a ride. The states are intuitive. When the demo shows "driver is en route → arrived → waiting for rider → timeout → no-show fee charged," people immediately get it.
- **Multi-party coordination is inherent** — a trip involves a rider, a driver, the platform, and a payment processor. These are genuinely independent actors with independent state.
- **Financial correctness is critical** — payment holds must be released or captured correctly. Drivers must be paid. Platform fees must be calculated. Getting the state machine wrong means losing money or charging people incorrectly.
- **Rich failure modes** — no drivers available, driver cancels after accepting, rider doesn't show up, rider cancels mid-trip, payment authorization fails, trip abandoned. Each failure has a different resolution path. This is where verification matters.

## Scale

5 machines, ~34 states total. Each child machine is meaningful (not a trivial 3-state stub) but small enough to read in one sitting.

| Machine | States | Role |
|---------|--------|------|
| **TripCoordinator** | ~10 | Parent — orchestrates the full trip lifecycle |
| **DriverMatching** | ~6 | Find nearby drivers, offer trip, handle accept/decline/timeout |
| **PaymentAuth** | ~5 | Estimate fare, pre-authorize payment hold |
| **TripExecution** | ~7 | Pickup → ride → dropoff, with rider no-show handling |
| **FareSettlement** | ~6 | Calculate actual fare, charge rider, pay driver, platform fee |

---

## Machine Designs

### 1. TripCoordinator (parent, ~10 states)

The top-level orchestrator. Manages the trip from request to completion.

```
States:
  idle [initial]         — waiting for trip request
  requesting [parallel]  — matching + payment auth run concurrently
    region matching:
      finding_driver [initial]  — invoke DriverMatching
      driver_found [final]
    region payment:
      authorizing [initial]     — invoke PaymentAuth
      authorized [final]
  pickup                 — invoke TripExecution (timeout: 10min → no_show)
  in_trip                — trip in progress (entered when TripExecution signals pickup complete)
  completing             — invoke FareSettlement
  completed [final]      — trip done, everyone paid
  cancelled [final]      — trip cancelled (various reasons)
  no_show [final]        — rider didn't show, cancellation fee charged
  failed [final]         — unrecoverable error (payment failed, system error)
```

Key transitions:
- `idle → requesting` on REQUEST_TRIP (rider wants a ride)
- `requesting → pickup` when both regions complete (driver found AND payment authorized)
- `requesting → cancelled` if no drivers available (matching child reaches `no_drivers`)
- `requesting → failed` if payment auth fails (payment child reaches `declined`)
- `pickup → in_trip` when TripExecution signals rider picked up
- `pickup → no_show` on timeout (rider didn't appear within 10min — kills TripExecution child)
- `in_trip → completing` when TripExecution reaches `arrived_destination`
- `completing → completed` when FareSettlement reaches `settled`
- Any active state → `cancelled` on RIDER_CANCEL (kills whatever child is running)

**What this exercises:**
- Parallel invocation via regions (matching + payment must both succeed)
- Sequential invocation (pickup, then settlement)
- Timeout as invocation deadline (10min no-show window kills TripExecution)
- Cancellation from parent (RIDER_CANCEL kills active child)
- Multiple terminal states with different meanings
- Input mapping (trip details → each child)

### 2. DriverMatching (child, ~6 states)

Finds available drivers nearby, offers the trip to the best match, handles accept/decline/timeout, and retries with the next driver.

```
States:
  searching [initial]   — querying nearby available drivers
  offering              — trip offered to a specific driver
  driver_accepted       — driver said yes, confirming assignment
  matched [final]       — driver locked in, ready for pickup
  no_drivers [final]    — no drivers available or all declined
  search_error [final]  — system error during search

Events: DRIVERS_FOUND, NO_DRIVERS_NEARBY, DRIVER_ACCEPTED, DRIVER_DECLINED, OFFER_TIMEOUT, CONFIRMED, ALL_DECLINED, SEARCH_ERROR

Timeout: offering has 15s timeout → try next driver (or no_drivers if none left)
```

Key transitions:
- `searching → offering` on DRIVERS_FOUND (found candidates, offer to top match)
- `searching → no_drivers` on NO_DRIVERS_NEARBY
- `offering → driver_accepted` on DRIVER_ACCEPTED
- `offering → searching` on DRIVER_DECLINED or timeout (try next driver)
- `offering → no_drivers` on ALL_DECLINED (last driver declined)
- `driver_accepted → matched` on CONFIRMED
- Any → `search_error` on SEARCH_ERROR

**What this exercises:**
- Internal retry loop (`offering → searching → offering` cycle)
- Timeout within child (15s driver response window)
- Three distinct final states — parent routes differently for each
- Input mapping: receives `{ pickup_lat, pickup_lng, destination_lat, destination_lng }` from parent

### 3. PaymentAuth (child, ~5 states)

Estimates the fare based on route, pre-authorizes a hold on the rider's payment method.

```
States:
  estimating [initial]  — calculating fare estimate from route
  authorizing           — requesting payment hold from processor
  authorized [final]    — hold placed, funds reserved
  declined [final]      — payment method declined or insufficient funds
  auth_error [final]    — payment processor unavailable

Events: FARE_ESTIMATED, AUTH_SUCCESS, AUTH_DECLINED, PROCESSOR_ERROR

Guard: sufficient_funds (ctx.estimated_fare <= ctx.available_balance)
```

Key transitions:
- `estimating → authorizing` on FARE_ESTIMATED
- `authorizing → authorized` on AUTH_SUCCESS
- `authorizing → declined` on AUTH_DECLINED
- `authorizing → auth_error` on PROCESSOR_ERROR

**What this exercises:**
- Runs in parallel with DriverMatching (inside parent's parallel regions)
- Clean success/failure distinction via final states
- Input mapping: receives `{ rider_payment_method, pickup, destination }` from parent
- Relatively simple — shows that not every child machine needs to be complex

### 4. TripExecution (child, ~7 states)

Manages the trip from driver dispatch through dropoff. This is the longest-running child machine.

```
States:
  en_route [initial]      — driver heading to pickup location
  arrived_pickup          — driver at pickup, waiting for rider
  rider_boarding          — rider getting in
  navigating              — trip in progress, driving to destination
  arrived_destination     — arrived, trip complete
  trip_complete [final]   — rider dropped off successfully
  trip_abandoned [final]  — trip ended abnormally (rider no-show at pickup is handled by parent timeout, this covers mid-trip issues)

Events: ARRIVED_AT_PICKUP, RIDER_IN, TRIP_STARTED, APPROACHING_DESTINATION, ARRIVED_AT_DESTINATION, RIDER_OUT, RIDER_NO_BOARD, EMERGENCY_STOP

Timeout: arrived_pickup has 5min timeout → trip_abandoned (rider isn't coming out)
```

Key transitions:
- `en_route → arrived_pickup` on ARRIVED_AT_PICKUP
- `arrived_pickup → rider_boarding` on RIDER_IN
- `arrived_pickup → trip_abandoned` on timeout (5min — rider never came out)
- `rider_boarding → navigating` on TRIP_STARTED
- `navigating → arrived_destination` on ARRIVED_AT_DESTINATION
- `arrived_destination → trip_complete` on RIDER_OUT

**What this exercises:**
- Longest-lived child machine (minutes, not seconds)
- Internal timeout (5min rider boarding window)
- Interplay with parent timeout (parent also has a no-show timeout on the invoking state — demonstrates nested deadline behavior)
- Two final states: `trip_complete` (normal) vs `trip_abandoned` (abnormal) — parent routes differently

### 5. FareSettlement (child, ~6 states)

Calculates the actual fare, charges the rider, pays the driver, and takes the platform cut.

```
States:
  calculating [initial]    — computing actual fare (distance, time, surge, discounts)
  charging_rider           — capturing the pre-authorized payment
  paying_driver            — transferring driver's cut
  issuing_receipt          — generating receipt for both parties
  settled [final]          — all money moved correctly
  settlement_error [final] — payment capture or transfer failed

Events: FARE_CALCULATED, RIDER_CHARGED, DRIVER_PAID, RECEIPTS_SENT, CHARGE_FAILED, TRANSFER_FAILED
```

Key transitions:
- `calculating → charging_rider` on FARE_CALCULATED
- `charging_rider → paying_driver` on RIDER_CHARGED
- `paying_driver → issuing_receipt` on DRIVER_PAID
- `issuing_receipt → settled` on RECEIPTS_SENT
- `charging_rider → settlement_error` on CHARGE_FAILED
- `paying_driver → settlement_error` on TRANSFER_FAILED

**What this exercises:**
- Sequential pipeline within a child (calculate → charge → pay → receipt)
- Failure at any step stops the pipeline (charge failed vs transfer failed are distinguishable)
- Input mapping: receives `{ actual_distance, actual_duration, surge_multiplier, pre_auth_id, driver_id }` — data accumulated across earlier phases
- Final child in the chain — demonstrates that settlement depends on data from all prior machines

---

## Cross-Machine Verification

This demo is designed to exercise the verifier's cross-machine analysis:

| Check | How This Demo Exercises It |
|-------|---------------------------|
| **Machine resolution** | 4 `invoke:` references resolve to machines in same file |
| **Circular invocation** | No cycles — verifier confirms cleanly |
| **Child reachability to final** | Every child has reachable final states |
| **on_done/on_error validation** | Parent handles all child outcomes |
| **Missing on_error** | Could omit on_error from FareSettlement to demonstrate the warning |
| **Combined state budget** | ~34 states, within 64-state limit |
| **Input field validation** | Parent passes pickup/destination/payment fields to children |

**Intentional test fixtures** (for the test suite, not the demo):
- A version with circular invocation (TripExecution invokes TripCoordinator) — verifier rejects
- A version where DriverMatching has no reachable final state — verifier catches parent deadlock
- A version with undeclared on_done event — verifier catches

---

## Interactive CLI

```
$ pnpm run trip

🚗 Ride-Hailing Trip Coordinator
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Rider: Alice
From:  123 Main St
To:    456 Oak Ave

[1/4] Requesting ride...
  Finding driver      │ Authorizing payment
  ● searching         │ ● estimating
  ● offering — Marcus │ │  $18.50 estimated
    (4.9★, 3 min)     │ ● authorizing
  ⏱ waiting (15s)...  │ ✓ authorized — $22.00 hold
  ✓ Marcus accepted   │

[2/4] Pickup...
  ● en_route — Marcus is 3 min away
  ● arrived — Marcus is here (Silver Camry, ABC-1234)
  ⏱ Waiting for rider (5:00)...
  ● boarding — Alice is in

[3/4] Trip in progress...
  ● navigating — 12 min to destination
  ● arriving — Approaching 456 Oak Ave
  ✓ Arrived

[4/4] Settling fare...
  ● calculating — Distance: 4.2 mi, Time: 14m
    Base $3.00 + Distance $6.30 + Time $3.50 = $12.80
    Surge 1.0x → $12.80
  ● charging — Capturing $12.80 (releasing $9.20 hold)
  ● paying — Driver: $10.24 (80%) | Platform: $2.56 (20%)
  ● receipts — Sent to rider and driver
  ✓ Settled

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Trip complete
   Duration:  14m 23s
   Distance:  4.2 mi
   Fare:      $12.80
   Driver:    Marcus (4.9★)
```

### Failure Mode Flags

```bash
go run ./cmd/trip                      # happy path
go run ./cmd/trip --no-drivers         # nobody available → cancelled
go run ./cmd/trip --driver-declines    # first driver declines, match retries with second
go run ./cmd/trip --payment-declined   # card declined during parallel auth → cancelled
go run ./cmd/trip --rider-no-show      # rider doesn't board → timeout → no-show fee
go run ./cmd/trip --rider-cancels      # rider cancels mid-trip → cancel fee + settlement
go run ./cmd/trip --settlement-error   # payment capture fails after trip → settlement_error
go run ./cmd/trip --chaos              # random failure in random phase
```

Each failure path shows the child machine reaching its failure state, the parent reacting (cancelling other children if needed), and the system reaching a well-defined terminal state. The parallel phase is particularly interesting on failure — if payment is declined while matching is still searching, the parent exits the parallel state, killing the matching child.

### Why Each Failure Mode Matters

| Flag | What It Demonstrates |
|------|---------------------|
| `--no-drivers` | Child reaches failure final state, parent routes to `cancelled` |
| `--driver-declines` | Internal retry loop inside child (offer → decline → re-search → offer next) |
| `--payment-declined` | One parallel region fails, parent exits and kills the other region |
| `--rider-no-show` | Parent timeout kills child, transitions to `no_show` + charges fee |
| `--rider-cancels` | Parent event triggers cancellation of running child mid-execution |
| `--settlement-error` | Last child fails — demonstrates late-stage failure handling |
| `--chaos` | Randomized — tests that ALL failure paths reach a terminal state |

---

## Phase 4 Feature Coverage

| Phase 4 Feature | Where It's Exercised |
|-----------------|---------------------|
| Single-file multi-machine | All 5 machines in one `.orca.md` file |
| `invoke:` on state entry | Every parent-to-child transition |
| `on_done` with outcome routing | Parent routes based on `finalState` (matched vs no_drivers, etc.) |
| `on_error` handling | System errors in any child propagate to parent |
| Input mapping | Parent passes trip details, payment info, driver info to each child |
| Parallel invocation (regions) | DriverMatching + PaymentAuth run concurrently |
| `all-final` sync | Both matching and payment must complete before pickup |
| Timeout as deadline | 10min no-show on pickup state, 15s driver offer window |
| Forced cancellation | RIDER_CANCEL kills active child; parallel exit kills surviving region |
| Timeout inside child | DriverMatching: 15s offer window; TripExecution: 5min boarding window |
| Cross-machine verification | Verifier checks all 5 machines together |
| Snapshot/restore with children | Snapshot mid-trip includes TripExecution child state |

---

## Incremental Implementation Path

This demo depends on two things: the Go runtime (`runtime-go`) and Phase 4 machine invocation support in that runtime. The implementation naturally breaks into a Go runtime phase and a demo phase.

### Phase A: Go Runtime (runtime-go)

Build the Go runtime to feature parity with runtime-ts and runtime-python. This is prerequisite work — the demo can't start until the runtime exists.

#### A1: Core runtime
Markdown parser (`ParseOrcaMd`, `ParseOrcaAuto`), `OrcaMachine` struct, basic state transitions, context management. Zero external dependencies (match Python's approach). Test with `simple-toggle.orca.md`.

#### A2: Guards and actions
Guard evaluation for complex expressions (`compare`, `and`, `or`, `not`, `nullcheck`). Action registration via `RegisterAction()`. Test with `payment-processor.orca.md`.

#### A3: Event bus
Pub/sub and request/response patterns. Effect handler registration and routing. Test with a simple effect round-trip.

#### A4: Timeouts
Timeout transitions via goroutines with `context.Context` cancellation. Auto-cancel on state exit or machine stop. Test with dedicated timeout scenarios.

#### A5: Hierarchical states and parallel regions
Nested state support, parallel regions with multi-region state values, per-leaf event dispatch, sync strategies (`all-final`, `any-final`). Test with `hierarchical-game.orca.md` and `parallel-order.orca.md`.

#### A6: Snapshot/restore
Deep-copy state + context, timeout cancellation/restart. Test with snapshot/restore scenarios.

#### A7: Machine invocation
Child machine lifecycle (start on entry, stop on exit), input mapping, completion events (`{ finalState, context }`), forced cancellation, snapshot/restore with children. Test with `invocation-order.orca.md`.

### Phase B: Ride-Hailing Demo (demo-go)

Once the Go runtime has invocation support, build the demo in stages:

#### B1: Single child, sequential
TripCoordinator invokes just DriverMatching. No parallel, no timeout. Proves basic invoke/on_done/on_error works in Go. (~16 states, 2 machines)

#### B2: Add parallel invocation
Add PaymentAuth as a parallel region alongside DriverMatching. Proves parallel invoke with `all-final` sync works. (~21 states, 3 machines)

#### B3: Add timeout as deadline
Add TripExecution with the no-show timeout on the parent's `pickup` state. Proves timeout kills the child via `context.Context` cancellation. (~28 states, 4 machines)

#### B4: Add outcome routing and settlement
Add FareSettlement with input that depends on accumulated data from prior phases. Proves outcome-dependent input mapping and end-to-end flow. (~34 states, 5 machines)

#### B5: Add cancellation and failure modes
Wire up RIDER_CANCEL, driver-declines retry loop, and all the CLI failure flags. Proves cancellation of running children.

#### B6: Interactive CLI
Build the terminal display with progress updates and failure mode flags.

---

## Package Structure

```
packages/demo-go/
  go.mod                        # module orca-demo-go, depends on runtime-go
  go.sum
  orca/
    trip.orca.md                # all 5 machines in one file
  cmd/
    trip/
      main.go                  # entry point, arg parsing, failure mode injection
  internal/
    handlers/
      matching.go              # DriverMatching action handlers (simulated search/offer)
      payment.go               # PaymentAuth action handlers (simulated auth)
      trip.go                  # TripExecution action handlers (simulated navigation)
      settlement.go            # FareSettlement action handlers (simulated payment)
      coordinator.go           # TripCoordinator action handlers
    display/
      display.go               # terminal output formatting, progress display
    simulation/
      simulation.go            # timing, fake data generation, chaos mode
  trip_test.go                 # smoke tests: happy path + each failure mode
```

---

## What This Proves

If this demo works correctly, it demonstrates:

1. **Natural decomposition** — five focused machines are obviously better than one 34-state monolith. A flat trip state machine with matching retry loops, parallel payment auth, and settlement logic would be unreadable.
2. **Verified multi-party coordination** — the verifier proves that money can't get stuck (no deadlocks in settlement), drivers can't be matched without payment auth (parallel sync), and every failure mode reaches a terminal state.
3. **Parallel orchestration that matters** — matching and payment authorization genuinely should run concurrently. Waiting for one before starting the other wastes time on every trip.
4. **Cancellation is safe** — killing a child mid-flight (rider cancels, timeout fires) is proven safe by verification. No orphaned state.
5. **Incremental complexity** — the implementor builds from 2 machines to 5, adding one capability at a time. Each stage is testable independently.
6. **Real-world resonance** — anyone who has taken a ride-hail trip can watch the demo and understand exactly what the state machine is doing, and appreciate what would happen if the state machine had a bug.
