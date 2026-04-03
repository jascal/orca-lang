# Rust Runtime with Fortran FFI

**Status:** Draft — for future implementation session
**Date:** 2026-04-01

---

## Overview

Build a Rust-based Orca runtime with a C-compatible FFI layer, enabling Fortran (and other C-compatible callers) to instantiate and drive Orca state machines. The Rust runtime lives in the orca-lang monorepo.

**Goals:**
- Rust runtime (`runtime-rust/`) producing a `.so`/`.a` with pure C ABI
- Orca runtime (parser, verifier, machine executor, effects) in Rust
- Fortran FFI demo (`demo-fortran/`) — N-agent market simulation

**Non-Goals:**
- Not a full Orca language binding for Fortran

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Fortran Caller                                                             │
│                                                                             │
│  call orca_init(handle_ptr, machine_md_string)                              │
│  call orca_send(handle, event_json)          ← non-blocking dispatch        │
│  call orca_wait(handle)                      ← blocks until idle            │
│  call orca_send_and_wait(handle, event_json) ← convenience: send + wait     │
│  call orca_poll(handle) → status            (advanced / concurrent use)     │
│  call orca_state(handle) → state_json                                       │
│  call orca_register_action(handle, name, c_func_ptr)                        │
│  call orca_register_effect(handle, name, effect_fn)        (optional)       │
└───────────────────────────────┬─────────────────────────────────────────────┘
                                │ C ABI (extern "C")
┌───────────────────────────────▼─────────────────────────────────────────────┐
│  runtime-rust (Rust, #[repr(C)])                                            │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ runtime/ (internal module)                                            │  │
│  │   ├── parser — .orca.md → AST (ported from orca-lang)                 │  │
│  │   ├── verifier — reachability, deadlock, guard determinism            │  │
│  │   ├── executor — state machine step, guard eval, context update       │  │
│  │   ├── event_bus — pub/sub                                             │  │
│  │   └── effects — registry + effect emission                            │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ FFI surface (#[repr(C)] + #[no_mangle] extern "C")                    │  │
│  │   orca_init, orca_free, orca_send, orca_wait,                         │  │
│  │   orca_poll, orca_state,                                              │  │
│  │   orca_register_action, orca_register_effect,                         │  │
│  │   orca_send_and_wait, orca_last_error                                 │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Package Structure

All packages live under `orca-lang/packages/`, alongside existing demos:

```
orca-lang/
├── docs/
│   └── runtime-rust-fortran.md   # this file
│
└── packages/
    ├── runtime-rust/              # Rust runtime with C FFI
    │   ├── Cargo.toml
    │   ├── run_orca_ffi.h        # C header
    │   └── src/
    │       ├── lib.rs             # FFI exports
    │       └── runtime/           # Orca runtime (internal mod)
    │           ├── mod.rs
    │           ├── parser.rs       # from orca-lang parser
    │           ├── verifier.rs     # from orca-lang verifier
    │           ├── executor.rs     # state machine engine
    │           ├── event_bus.rs    # pub/sub
    │           └── effects.rs      # effect registry
    │
    └── demo-fortran/              # Fortran FFI demo — market simulation
        ├── src/
        │   ├── demo_main.f90      # N-agent market simulation
        │   └── demo_actions.f90   # Fortran action callbacks
        ├── include/
        │   └── run_orca_ffi.h    # copied from runtime-rust/
        ├── Makefile
        └── test/
            └── test_market.sh
```

**Relationship to existing demos:**
- `demo-fortran/` follows the same pattern as `demo-ts/`, `demo-python/`, `demo-go/` — each demonstrates the runtime in a different language
- `runtime-rust/` is a new runtime alongside `runtime-ts/`, `runtime-python/`, `runtime-go/` — but it is a bridge runtime (Rust with C FFI), not a native-language runtime
- `demo-fortran/` uses **poll mode** — Fortran orchestrates 80 agents, owns the tick loop and scheduler

---

## C API Surface

### Header (`run_orca_ffi.h`)

```c
#ifndef RUN_ORCA_FFI_H
#define RUN_ORCA_FFI_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

// Opaque handle to an Orca machine instance
typedef struct orca_handle orca_handle_t;

// Error codes
#define ORCA_OK           0
#define ORCA_ERR_PARSE   -1
#define ORCA_ERR_VERIFY  -2
#define ORCA_ERR_RUNTIME -3
#define ORCA_ERR_INVALID  -4

// Initialize an Orca machine from a .orca.md markdown string.
// Parses and verifies the machine. Returns a handle via handle_ptr.
int orca_init(
    const char* orca_md_source,
    size_t source_len,
    orca_handle_t** handle_ptr
);

// Free a machine handle and all associated resources.
void orca_free(orca_handle_t* handle);

// Dispatch an event to the machine. NON-BLOCKING — returns immediately.
// The machine processes the event in the background; use orca_wait or orca_poll
// to determine when it reaches a stable (idle) state.
int orca_send(
    orca_handle_t* handle,
    const char* event_json,
    size_t event_len
);

// Block until the machine reaches an idle state.
// Use after orca_send to synchronize.
int orca_wait(orca_handle_t* handle);

// Convenience: send an event and block until idle. Equivalent to
// orca_send + orca_wait. Use this when you want blocking semantics
// without managing the two-step sequence yourself.
int orca_send_and_wait(
    orca_handle_t* handle,
    const char* event_json,
    size_t event_len
);

// Poll the machine — for advanced use only.
// Returns: 0 = idle/done, 1 = busy, negative = error.
// Use orca_wait (blocking) or orca_send_and_wait instead for most cases.
// Exposed for integration with external schedulers or progress tracking.
int32_t orca_poll(orca_handle_t* handle);

// Get current machine state as JSON.
// Caller provides buf[buf_len]; actual size written is returned in *actual_len.
int orca_state(
    orca_handle_t* handle,
    char* buf,
    size_t buf_len,
    size_t* actual_len
);

// Register an action callback (C function pointer).
// callback receives (context_json, event_json) → returns result_json as c string.
typedef const char* (*orca_action_fn)(
    const char* context_json,
    const char* event_json
);

int orca_register_action(
    orca_handle_t* handle,
    const char* action_name,
    orca_action_fn callback
);

// Register an effect handler for external I/O.
// handler receives (effect_name, input_json) → returns output_json.
typedef const char* (*orca_effect_fn)(
    const char* effect_name,
    const char* input_json
);

int orca_register_effect(
    orca_handle_t* handle,
    const char* effect_name,
    orca_effect_fn handler_fn
);

// Get the last error message (valid until next call on this handle).
const char* orca_last_error(orca_handle_t* handle);

#ifdef __cplusplus
}
#endif

#endif // RUN_ORCA_FFI_H
```

---

## Demo Scenario

### demo-fortran — "Market Simulation with N Agent State Machines (poll mode)"

**What it demonstrates:** Fortran *orchestrates* — it owns the tick loop, broadcasts events, manages concurrency across 80 agents, and computes the market price. This is Fortran driving the simulation. Uses `orca_poll` so Fortran controls when to advance the tick.

**Why poll mode fits:** The market simulation *is* the Fortran program's domain. Fortran has the scheduler, the tick loop, the price computation. Rust is just the state machine engine. Fortran sends ticks, polls for completion, reads agent states, computes the macro result, then broadcasts the next tick. Poll mode keeps the orchestration in Fortran where it belongs.

**The agents:** Three machine types model distinct economic roles. All run concurrently in Fortran arrays.

```markdown
# machine Producer

## context
| Field     | Type   | Default |
|-----------|--------|---------|
| agent_id  | string |         |
| inventory | int    | 100     |
| price     | float  | 10.0    |
| tick      | int    | 0       |

## events
- tick
- price_signal

## state active [initial]
> Produces goods each tick, adjusts price with inventory

## transitions
| Source  | Event        | Guard        | Target  | Action      |
|---------|--------------|--------------|---------|-------------|
| active  | tick         |              | active  | produce     |
| active  | price_signal | price > 15.0 | active  | cut_price   |
| active  | price_signal | price < 5.0  | active  | raise_price |

## actions
| Name        | Signature           | Effect                  |
|-------------|---------------------|-------------------------|
| produce     | `(ctx) → Context`  | `inventory += 10`       |
| cut_price   | `(ctx) → Context`  | `price -= 1.0`          |
| raise_price | `(ctx) → Context`  | `price += 1.0`          |
```

```markdown
# machine Consumer

## context
| Field   | Type   | Default  |
|---------|--------|----------|
| agent_id| string |          |
| cash    | float  | 1000.0   |
| goods   | int    | 0        |
| tick    | int    | 0        |

## events
- tick
- price_signal

## state active [initial]
> Each tick: buy if price is low, sell if high, hold otherwise

## transitions
| Source  | Event        | Guard        | Target  | Action |
|---------|--------------|--------------|---------|--------|
| active  | tick         | price < 8.0  | active  | buy    |
| active  | tick         | price > 12.0 | active  | sell   |
| active  | tick         | else         | active  | hold   |

## actions
| Name | Signature          | Effect                        |
|------|--------------------|-------------------------------|
| buy  | `(ctx) → Context`  | `goods += 1; cash -= price`  |
| sell | `(ctx) → Context`  | `goods -= 1; cash += price`  |
| hold | `(ctx) → Context`  | —                             |
```

```markdown
# machine Speculator

## context
| Field    | Type   | Default |
|---------|--------|---------|
| agent_id | string |         |
| cash     | float  | 500.0   |
| position | int    | 0       |
| tick     | int    | 0       |

## events
- tick
- price_signal

## state idle [initial]
> Watching, waiting for a signal

## state holding [final]
> Committed to a position

## transitions
| Source  | Event        | Guard         | Target  | Action |
|---------|--------------|---------------|---------|--------|
| idle    | tick         | rand() > 0.5 | holding | buy    |
| idle    | tick         | else          | idle    | hold   |
| holding | price_signal |               | holding |        |

## actions
| Name | Signature          | Effect                      |
|------|--------------------|-----------------------------|
| buy  | `(ctx) → Context`  | `position = 1; cash -= price` |
| hold | `(ctx) → Context`  | —                           |
```

**What Fortran does (poll mode):**

```fortran
program market_simulation
  use, intrinsic :: iso_c_binding
  include 'run_orca_ffi.h'

  integer, parameter :: N_PRODUCERS = 20
  integer, parameter :: N_CONSUMERS = 50
  integer, parameter :: N_SPECULATORS = 10
  integer, parameter :: N_TICKS = 100

  type(c_ptr) :: producers(N_PRODUCERS)
  type(c_ptr) :: consumers(N_CONSUMERS)
  type(c_ptr) :: speculators(N_SPECULATORS)
  real :: market_price = 10.0
  integer :: i, tick

  ! 1. Instantiate all agents
  do i = 1, N_PRODUCERS
    call orca_init(producer_md, len(producer_md), producers(i))
    call orca_register_action(producers(i), "produce", c_funloc(producer_produce))
    call orca_register_action(producers(i), "cut_price", c_funloc(producer_cut_price))
    call orca_register_action(producers(i), "raise_price", c_funloc(producer_raise_price))
  end do

  do i = 1, N_CONSUMERS
    call orca_init(consumer_md, len(consumer_md), consumers(i))
    call orca_register_action(consumers(i), "buy", c_funloc(consumer_buy))
    call orca_register_action(consumers(i), "sell", c_funloc(consumer_sell))
    call orca_register_action(consumers(i), "hold", c_funloc(consumer_hold))
  end do

  do i = 1, N_SPECULATORS
    call orca_init(speculator_md, len(speculator_md), speculators(i))
    call orca_register_action(speculators(i), "buy", c_funloc(speculator_buy))
    call orca_register_action(speculators(i), "hold", c_funloc(speculator_hold))
  end do

  ! 2. Run simulation ticks — Fortran owns the scheduler
  do tick = 1, N_TICKS
    ! 2a. Dispatch tick to all agents (non-blocking)
    do i = 1, N_PRODUCERS
      call orca_send(producers(i), '{"type":"tick"}')
    end do
    do i = 1, N_CONSUMERS
      call orca_send(consumers(i), '{"type":"tick","payload":{"price":'//market_price//'}}')
    end do
    do i = 1, N_SPECULATORS
      call orca_send(speculators(i), '{"type":"tick"}')
    end do

    ! 2b. Wait for all agents to finish processing (blocking wait per agent)
    do i = 1, N_PRODUCERS
      call orca_wait(producers(i))
    end do
    do i = 1, N_CONSUMERS
      call orca_wait(consumers(i))
    end do
    do i = 1, N_SPECULATORS
      call orca_wait(speculators(i))
    end do

    ! 2c. Collect state from all agents, compute new market price
    call compute_market_price(producers, consumers, market_price)

    ! 2d. Dispatch price signal to all agents (non-blocking)
    do i = 1, N_PRODUCERS
      call orca_send(producers(i), '{"type":"price_signal","payload":{"price":'//market_price//'}}')
    end do
    do i = 1, N_CONSUMERS
      call orca_send(consumers(i), '{"type":"price_signal","payload":{"price":'//market_price//'}}')
    end do
    do i = 1, N_SPECULATORS
      call orca_send(speculators(i), '{"type":"price_signal","payload":{"price":'//market_price//'}}')
    end do

    ! 2e. Wait for price signal round to complete
    do i = 1, N_PRODUCERS
      call orca_wait(producers(i))
    end do
    do i = 1, N_CONSUMERS
      call orca_wait(consumers(i))
    end do
    do i = 1, N_SPECULATORS
      call orca_wait(speculators(i))
    end do
  end do

  ! 3. Print final wealth distribution
  call print_wealth_report(producers, consumers, speculators)

  ! 4. Cleanup
  do i = 1, N_PRODUCERS; call orca_free(producers(i)); end do
  do i = 1, N_CONSUMERS; call orca_free(consumers(i)); end do
  do i = 1, N_SPECULATORS; call orca_free(speculators(i)); end do
end program
```

**Why it's compelling:** Fortran owns the scheduler — the tick loop, event broadcasting, and market price computation are all Fortran. 80 state machine agents run inside Rust, but Fortran drives them. `orca_send` fires events to all agents concurrently; `orca_wait` synchronizes per agent. The boundary is clean: Rust handles state machine execution; Fortran handles simulation logic. Machine definitions are visible as string constants in the Fortran source. Emergent macro behavior (price equilibrium, boom/bust cycles) from simple local rules — no central coordinator.

**Emergent behaviors to expect:** price convergence toward equilibrium, speculative bubbles, inventory oscillations.

---

## Implementation Phases

### Phase 1: FFI Skeleton
- Create `packages/runtime-rust/` with empty `src/lib.rs`, `src/runtime/mod.rs`
- Write `run_orca_ffi.h` C header
- Implement empty `#[no_mangle]` stubs returning `ORCA_ERR_RUNTIME`
- Build as `.so`, verify C compiler can include header and link
- **Deliverable:** `libruntime_rust.so` + header compile and link from C

### Phase 2: Orca Runtime Port
- Port `runtime/parser.rs` — markdown format only, single machine, from `packages/orca-lang/src/parser`
- Port `runtime/verifier.rs` — reachability, deadlock, guard determinism
- Port `runtime/executor.rs` — step function, guard eval, context update
- Port `runtime/event_bus.rs` + `runtime/effects.rs`
- Test in Rust: parse + verify + step a machine without touching FFI
- **Deliverable:** Rust-only: parse `.orca.md`, verify, run transitions

### Phase 3: FFI Integration
- Wire `orca_init`: parse + verify → `OrcaMachine` instance
- Wire `orca_send`: parse event JSON → `machine.send()` → return immediately (non-blocking)
- Wire `orca_wait`: run machine processing loop → block until machine reaches idle state
- Wire `orca_send_and_wait`: convenience wrapper calling `orca_send` + `orca_wait`
- Wire `orca_state`: serialize context to JSON
- Wire `orca_register_action` / `orca_register_effect`: store C callbacks
- Write C smoke test to exercise init/send/state cycle
- **Deliverable:** C test: init → send event → get state works

### Phase 4: demo-fortran
- Create `packages/demo-fortran/`
- Write `demo_main.f90` — 80-agent market simulation (Producer/Consumer/Speculator)
- Write `demo_actions.f90` — Fortran action callbacks
- Makefile: build `runtime-rust.so` + compile Fortran
- **Deliverable:** `make run` → 100-tick market simulation, prints wealth report

### Phase 5: Polish
- `orca_last_error`: `thread_local` error storage in Rust
- All error codes mapped from `Result`
- Memory safety: `orca_free` drops `Box<OrcaHandle>` correctly
- C header and Rust docs on public API

---

## Key Design Decisions

### `Box::into_raw` for handle allocation
`orca_handle_t*` is a raw pointer to `Box<OrcaHandle>`. `orca_free` calls `Box::from_raw` to reclaim memory. Standard Rust-C ABI pattern for opaque handles.

### JSON for event/state serialization
Keeps FFI surface minimal (`const char*` + `size_t`). Caller handles JSON encode/decode. Matches Orca's existing runtime design.

### Two-function FFI: `orca_send` (non-blocking) + `orca_wait` (blocking)
`orca_send` dispatches an event and returns immediately — the machine processes in the background. `orca_wait` blocks until the machine reaches idle. This split serves the market simulation cleanly: Fortran calls `orca_send` to all 80 agents concurrently, then `orca_wait` per agent to synchronize before reading state. `orca_send_and_wait` is a convenience wrapper for cases where blocking semantics are preferred.

`orca_poll` remains exposed for integration with external schedulers or progress tracking, but is not the primary interface.

### Action callbacks as raw C function pointers
`orca_register_action` takes a function pointer. Rust wraps it internally. Most portable FFI approach.

### Single-threaded executor
Rust Orca executor runs synchronously. From Fortran's perspective there is no threading and no async. If Fortran wants to run multiple machines concurrently, it manages the threads itself and uses `orca_poll` per-machine.

---

## Building

```bash
# Build the Rust runtime
cd packages/runtime-rust
cargo build --release
# Produces: target/release/libruntime_rust.so + run_orca_ffi.h

# Copy header to demo
cp run_orca_ffi.h ../demo-fortran/include/

# Run demo-fortran — poll mode (Fortran orchestrates 80 agents)
cd ../demo-fortran
make run
# → 100-tick market simulation, Fortran polls each agent each tick
# → prints wealth distribution at end
```

---

## Related Reading

- Orca `packages/orca-lang/AGENTS.md` — contribution guidance
- Orca `packages/orca-lang/src/parser/markdown.rs` — existing markdown parser reference
- Rust FFI: [Rustonomicon](https://doc.rust-lang.org/nomicon/ffi.html)
