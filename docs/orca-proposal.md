# Orca: Orchestrated State Machine Language

## A Proposal for an LLM-Native Code Generation Target

**Draft v0.1 — March 2026**

---

## 1. Motivation

Large language models generate code by predicting token sequences. Every mainstream programming language forces LLMs to perform tasks they are structurally bad at: tracking nested scope, maintaining implicit state across hundreds of tokens, balancing delimiters, and reasoning about control flow that branches and merges. The result is code that works most of the time but fails unpredictably, with error rates that climb steeply as program complexity increases.

Meanwhile, the things LLMs are *good* at — translating natural language descriptions into structured declarative specifications, producing tabular data, and reasoning about local relationships between entities — align almost perfectly with the computational formalism that predates programming languages entirely: the state machine.

This proposal describes **Orca** (State Machine Generation Language), a two-layer architecture designed as an LLM code generation target. The upper layer is a declarative state machine specification that captures program structure, control flow, and behavioral contracts. The lower layer consists of isolated, pure action functions that implement computation within individual states and transitions. The key insight is that these two layers have fundamentally different error profiles and verification strategies, and separating them allows each to be generated, verified, and maintained independently.

---

## 2. Design Principles

### 2.1 Separation of Topology and Computation

A program has two aspects: its *control structure* (what can happen in what order) and its *computation* (what values are transformed and how). Traditional programming languages interleave these. Orca separates them completely.

The **topology layer** (the state machine itself) defines states, transitions, events, guards, and hierarchical structure. It contains no computation — only names, connections, and declarative constraints. Getting the topology wrong produces architectural bugs: deadlocks, unreachable states, missing error handlers, race conditions. These are the bugs that are hardest to find in conventional code and most dangerous in production.

The **action layer** defines small, pure functions that execute when entering a state, exiting a state, or traversing a transition. Each action has a typed signature, explicit inputs and outputs, and no side effects beyond its declared interface. Getting an action wrong produces a local computational error — wrong value, wrong format, off-by-one — that is confined to a single state or transition and detectable by unit testing.

This separation matters because LLMs exhibit different failure modes at each layer. At the topology layer, LLMs are good at translating natural language behavioral descriptions into state/event structures but bad at ensuring global consistency (completeness, reachability, determinism). At the action layer, LLMs are good at generating short, well-typed pure functions but bad at maintaining correctness across long, stateful computations. Orca's architecture assigns each task to the layer where it can be verified most effectively.

### 2.2 Flat Structure for Generation, Hierarchy for Comprehension

The core generation target is a flat transition table: each row is a self-contained tuple of (source state, event, guard, target state, actions). The LLM can generate rows independently, in any order, without needing to track nesting depth, scope, or cross-references. Each row is syntactically complete and semantically self-contained.

For human comprehension and complex systems, Orca supports hierarchical states (as in Harel statecharts). But the hierarchy is optional sugar over the flat table — the canonical form is always the fully expanded transition list. This means the LLM can generate at whichever level of abstraction suits the problem: flat for simple protocols, hierarchical for complex UIs or workflows.

### 2.3 Immediate, Binary Verification

Every Orca artifact — topology or action — admits fast, deterministic verification. There is no "it seems to work" gray zone.

Topology verification checks:
- **Completeness**: every state handles every declared event (or explicitly delegates to a parent state)
- **Reachability**: every state is reachable from the initial state
- **Determinism**: no state has two transitions for the same event/guard combination
- **Deadlock freedom**: no non-final state has zero outgoing transitions
- **Type consistency**: every action's input types match the data available in its context

Action verification checks:
- **Type correctness**: the function's implementation matches its declared signature
- **Purity**: no side effects beyond the declared output
- **Unit tests**: auto-generated from the action's type signature and any declared invariants

All checks run in milliseconds. The LLM gets immediate pass/fail feedback and can retry or refine with precise error information.

### 2.4 Natural Language Proximity

Orca's vocabulary is drawn from natural language behavioral descriptions. States are named with noun phrases ("idle", "processing_payment", "awaiting_confirmation"). Events are named with verb phrases ("request_received", "timeout_expired", "user_cancelled"). Guards are named with predicate phrases ("has_valid_token", "retry_count_below_max"). This isn't cosmetic — it means the translation distance from a natural language specification to an Orca machine is shorter than for any conventional programming language.

---

## 3. Language Specification

### 3.1 Machine Declaration

An Orca machine is declared with a name, a context type (the data that flows through the machine), and an event vocabulary:

```
machine PaymentProcessor

context {
  order_id: string
  amount: decimal
  currency: string
  retry_count: int = 0
  payment_token: string?
  error_message: string?
}

events {
  submit_payment
  payment_authorized
  payment_declined
  payment_timeout
  retry_requested
  cancel_requested
  refund_requested
  settlement_confirmed
}
```

The context is the machine's state data — a typed record that is threaded through every transition. The event vocabulary is a closed set; the machine must explicitly handle every event in every state (or declare it ignored).

### 3.2 State Declarations

States are declared with optional entry/exit actions, internal activities, and metadata:

```
state idle [initial] {
  description: "Waiting for a payment submission"
  on_entry: -> reset_context
}

state validating {
  description: "Validating payment details before authorization"
  on_entry: -> validate_payment_details
  timeout: 5s -> validation_timeout
}

state authorizing {
  description: "Waiting for payment gateway response"
  on_entry: -> send_authorization_request
  timeout: 30s -> payment_timeout
}

state authorized {
  description: "Payment authorized, awaiting settlement"
  on_entry: -> log_authorization
}

state declined {
  description: "Payment was declined by the gateway"
  on_entry: -> format_decline_reason
}

state failed [final] {
  description: "Terminal failure state"
  on_entry: -> record_failure
}

state settled [final] {
  description: "Payment fully settled"
  on_entry: -> record_settlement
}
```

The `[initial]` and `[final]` markers are structural annotations used by the verifier. The `description` field is not just documentation — it is fed back to the LLM during action generation to provide context for what each state means.

### 3.3 Transition Table

The core of the machine. Each transition is a flat, self-contained row:

```
transitions {
  idle           + submit_payment                       -> validating      : initialize_payment
  validating     + payment_authorized                   -> authorizing     : prepare_auth_request
  validating     + payment_declined                     -> declined        : _
  authorizing    + payment_authorized                   -> authorized      : record_auth_code
  authorizing    + payment_declined                     -> declined        : increment_retry
  authorizing    + payment_timeout                      -> declined        : set_timeout_error
  declined       + retry_requested   [can_retry]        -> validating      : increment_retry
  declined       + retry_requested   [!can_retry]       -> failed          : set_max_retries_error
  declined       + cancel_requested                     -> failed          : _
  authorized     + settlement_confirmed                 -> settled         : _
  authorized     + refund_requested                     -> failed          : process_refund
}
```

Format: `source + event [guard] -> target : action`

The `_` symbol means "no action" (identity on context). Guards are named boolean predicates defined separately. The `!` prefix negates a guard.

This is the format the LLM generates. Note its properties:
- **Every row is independent.** Row 5 doesn't depend on row 4.
- **No nesting.** No parentheses, braces, or indentation-sensitivity.
- **Tabular.** Aligns to columns. LLMs are good at generating aligned tabular data.
- **Locally complete.** Each row contains all the information needed to understand that transition.

### 3.4 Guard Definitions

Guards are named boolean predicates over the context:

```
guards {
  can_retry: ctx.retry_count < 3
  has_valid_token: ctx.payment_token != null
  is_high_value: ctx.amount > 10000.00
}
```

Guards are the thinnest possible computational layer in the topology. They are pure boolean expressions over the context, with no side effects. They are independently testable: given a context, does the guard return true or false?

### 3.5 Action Signatures

Actions are declared in the topology with their signatures, but their implementations live in the action layer:

```
actions {
  reset_context:            (ctx: Context) -> Context
  initialize_payment:       (ctx: Context, event: SubmitPayment) -> Context
  validate_payment_details: (ctx: Context) -> Context
  send_authorization_request: (ctx: Context) -> Context + Effect<AuthRequest>
  prepare_auth_request:     (ctx: Context) -> Context
  record_auth_code:         (ctx: Context, event: PaymentAuthorized) -> Context
  increment_retry:          (ctx: Context) -> Context
  set_timeout_error:        (ctx: Context) -> Context
  set_max_retries_error:    (ctx: Context) -> Context
  format_decline_reason:    (ctx: Context, event: PaymentDeclined) -> Context
  process_refund:           (ctx: Context) -> Context + Effect<RefundRequest>
  record_failure:           (ctx: Context) -> Context
  log_authorization:        (ctx: Context) -> Context
  record_settlement:        (ctx: Context) -> Context
}
```

Note the `Effect<T>` type. Pure context transformations return `Context`. Actions that must interact with the outside world (API calls, database writes, UI updates) declare their effects explicitly. This makes the boundary between pure computation and I/O visible in the topology, enabling the verifier to reason about effect ordering and the runtime to handle effects appropriately (retries, timeouts, rollbacks).

### 3.6 Hierarchical States (Optional)

For complex machines, states can be nested:

```
state processing {
  description: "Actively processing the payment"

  contains {
    state validating [initial] { ... }
    state authorizing { ... }
    state authorized { ... }

    transitions {
      validating + payment_authorized -> authorizing : prepare_auth_request
      authorizing + payment_authorized -> authorized : record_auth_code
      ...
    }
  }

  # Transitions out of the parent apply to all children
  on cancel_requested -> failed : _
}
```

The `cancel_requested` transition on the parent state applies to all substates — if the machine is anywhere inside `processing` and receives `cancel_requested`, it transitions to `failed`. This is Harel statechart semantics, and it's a natural way to express "regardless of where we are in this process, cancellation is always possible."

Crucially, hierarchical machines are **expanded** to flat transition tables before verification. The hierarchy is a generation and comprehension convenience, not a fundamental construct. The verifier always works on the canonical flat form.

### 3.7 Parallel Regions (Optional)

For concurrent subsystems:

```
state active {
  parallel {
    region payment_flow {
      state processing [initial] { ... }
      state completed [final] { ... }
    }
    region notification_flow {
      state pending [initial] { ... }
      state sent [final] { ... }
    }
  }
}
```

Parallel regions run independently and synchronize on compound events. This captures patterns like "process the payment AND send the notification, and only proceed when both are done."

---

## 4. The Action Layer

### 4.1 Philosophy

The action layer is where conventional code lives — but in a highly constrained form. Every action is:

- **Small.** Typically 1–20 lines. It transforms a typed context, possibly extracting data from an event payload.
- **Pure.** No global state, no I/O (except via declared Effects), no ambient authority.
- **Typed.** Input and output types are fixed by the topology. The action can't consume or produce data that the machine doesn't know about.
- **Isolated.** An action cannot call another action. Composition happens at the topology level through state sequencing, not at the action level through function calls.

These constraints exist because they make each action independently generable, testable, and replaceable. If the LLM generates a bad action, you replace that one action without touching the topology or any other action.

### 4.2 Action Implementation

Actions are implemented in a host language. Orca is agnostic about which language — the topology is language-independent, and actions can be implemented in whatever language the target platform requires. For illustration, here are actions in a TypeScript-like syntax:

```typescript
// Pure context transformation
action increment_retry(ctx: Context): Context {
  return { ...ctx, retry_count: ctx.retry_count + 1 }
}

// Context transformation using event data
action record_auth_code(ctx: Context, event: PaymentAuthorized): Context {
  return {
    ...ctx,
    payment_token: event.auth_code,
    error_message: null
  }
}

// Action with declared side effect
action send_authorization_request(ctx: Context): [Context, Effect<AuthRequest>] {
  const request: AuthRequest = {
    order_id: ctx.order_id,
    amount: ctx.amount,
    currency: ctx.currency
  }
  return [ctx, emit(request)]
}

// Guard implementation
guard can_retry(ctx: Context): boolean {
  return ctx.retry_count < 3
}
```

### 4.3 Effect Handling

Effects are the bridge between the pure state machine and the impure outside world. When an action returns an Effect, the Orca runtime intercepts it and handles it according to the effect's type and the runtime's configuration:

```
effects {
  AuthRequest  -> http_post("/api/gateway/authorize")
  RefundRequest -> http_post("/api/gateway/refund")
  Notification -> message_queue("notifications")
}
```

Effect routing is declared in the machine's deployment configuration, not in the actions themselves. This means the same machine topology and the same action implementations can run against a real payment gateway in production, a mock gateway in testing, and a recorded trace in replay/debugging. The action code never changes.

Effects can also be asynchronous, with the runtime converting the external response back into an event that feeds into the state machine:

```
effect_responses {
  AuthRequest.success  -> payment_authorized { auth_code: response.code }
  AuthRequest.failure  -> payment_declined { reason: response.reason }
  AuthRequest.timeout  -> payment_timeout
}
```

This closes the loop: the machine emits an effect, the runtime executes it, and the response becomes an event that drives the next transition. The entire I/O cycle is visible in the machine specification.

---

## 5. Verification Pipeline

### 5.1 Topology Verification (Milliseconds)

The topology verifier runs the following checks on the flat transition table:

**Structural checks:**
- Every declared state is reachable from the initial state
- Every non-final state has at least one outgoing transition
- Every final state has zero outgoing transitions (except self-loops for ignored events)
- No orphan events (events declared but never used in any transition)
- No orphan actions (actions declared but never referenced)

**Completeness checks:**
- For every (state, event) pair, at least one transition exists or the event is explicitly declared as ignored in that state
- For every (state, event) pair with multiple transitions, guards are present and exhaustive (the disjunction of all guards for that pair is a tautology over the context type)

**Determinism checks:**
- For every (state, event) pair with multiple transitions, guards are mutually exclusive (no two guards can be simultaneously true for the same context)

**Liveness checks:**
- No strongly connected components in the transition graph consist entirely of non-final states with no exit transitions (no inescapable cycles)
- Every state has a path to at least one final state

These checks are standard graph algorithms and boolean satisfiability checks. They run in polynomial time (typically milliseconds even for machines with thousands of states). The verifier produces specific, actionable error messages:

```
TOPOLOGY ERROR: State 'authorizing' does not handle event 'cancel_requested'
  Suggestion: add transition 'authorizing + cancel_requested -> failed : _'
  Or declare: ignore cancel_requested in authorizing

TOPOLOGY ERROR: Non-deterministic transitions from 'declined':
  declined + retry_requested [can_retry] -> validating
  declined + retry_requested [!can_retry] -> failed
  Guards [can_retry, !can_retry] are exhaustive: OK
  Guards [can_retry, !can_retry] are mutually exclusive: OK
  (This is actually fine — no error)

TOPOLOGY ERROR: State 'pending_review' is unreachable from initial state 'idle'
  No incoming transitions found.
```

These error messages are designed to be consumed by both humans and LLMs. When fed back to the LLM, they provide enough context for the LLM to fix the topology without regenerating the entire machine.

### 5.2 Action Verification (Seconds)

Each action is verified independently:

**Type checking:**
- Action signature matches the declaration in the topology
- All fields of the output Context are present and correctly typed
- Event fields accessed in the action body exist in the event type

**Purity checking:**
- No I/O operations outside of declared Effects
- No mutation of input parameters
- No access to global state

**Auto-generated unit tests:**

The verifier automatically generates test cases from the action's type signature and any declared invariants:

```
// Auto-generated for increment_retry
test "increment_retry increases retry_count by 1" {
  const input = { ...defaultContext, retry_count: 0 }
  const output = increment_retry(input)
  assert(output.retry_count === 1)
}

test "increment_retry preserves other fields" {
  const input = { ...defaultContext, order_id: "test-123", retry_count: 2 }
  const output = increment_retry(input)
  assert(output.order_id === "test-123")
  assert(output.retry_count === 3)
}
```

For actions that are too complex for auto-generated tests, the LLM can generate targeted test cases as a separate step, using the action's description and the state machine's behavioral context.

### 5.3 Integration Verification (Seconds to Minutes)

Once topology and individual actions pass, integration verification checks the machine as a whole:

**Trace simulation:** The verifier generates random walks through the state machine, executing actions against synthetic contexts, and checks that no action throws an unexpected exception and all invariants hold at every step.

**Property checking:** Users (or the LLM) can declare machine-level properties:

```
properties {
  # The retry count never exceeds 3
  invariant: ctx.retry_count <= 3

  # Every path from idle to settled passes through authorized
  temporal: always(idle ~> settled implies passes_through(authorized))

  # A cancelled payment never reaches settled
  temporal: always(cancel_requested implies never_reaches(settled))
}
```

These properties are checked via bounded model checking on the finite state machine, which is decidable and tractable for machines of practical size.

---

## 6. LLM Generation Protocol

### 6.1 Two-Phase Generation

The LLM generates an Orca machine in two distinct phases, each with its own prompt, verification loop, and retry strategy.

**Phase 1: Topology Generation**

Input to the LLM:
- Natural language specification of the desired behavior
- Orca syntax reference (compact; fits in ~2000 tokens)
- Domain vocabulary hints (optional)

The LLM produces:
- Machine declaration (name, context type, event vocabulary)
- State declarations
- Transition table
- Guard definitions
- Action signatures (without implementations)

Verification feedback loop:
1. Parse the topology
2. Run topology verification
3. If errors exist, feed error messages back to the LLM with the original topology
4. LLM produces corrected topology
5. Repeat until clean (typically 1–3 iterations)

**Phase 2: Action Generation**

Input to the LLM:
- The verified topology (provides context for what each action must do)
- Each action's signature and the description of its source/target states
- The context type definition
- Host language syntax reference

The LLM produces each action independently. Actions can be generated in parallel across multiple LLM calls, since they are isolated by design.

Verification feedback loop (per action):
1. Type-check the action
2. Run auto-generated unit tests
3. If failures, feed error messages back to the LLM with the action and its context
4. LLM produces corrected action
5. Repeat until clean (typically 1–2 iterations)

### 6.2 Why Two Phases Matter

Topology and actions have fundamentally different generation characteristics:

| Property | Topology | Actions |
|---|---|---|
| Error type | Structural, global | Computational, local |
| Verification speed | Milliseconds | Seconds |
| Retry cost | Regenerate table | Regenerate one function |
| LLM strength | Behavioral specification | Short pure functions |
| LLM weakness | Global consistency | Long stateful computation |
| Verification tool | Graph algorithms, SAT | Type checker, unit tests |
| Blast radius of error | Entire machine | Single transition |

By separating the phases, a topology error never forces regeneration of already-verified actions, and an action error never invalidates the verified topology.

### 6.3 Incremental Elaboration

For complex systems, the generation can be further decomposed:

1. **Sketch phase.** The LLM generates top-level states and major transitions, leaving substates as stubs.
2. **Elaboration phase.** Each stub is expanded into a sub-machine, verified independently, then composed into the parent.
3. **Action phase.** Actions are generated for the fully elaborated machine.

This mirrors how human architects work — high-level design first, then progressive refinement — and keeps each generation step within the complexity budget that LLMs handle well.

---

## 7. Compilation Targets

An Orca machine is a platform-independent specification. The compiler translates it into executable code for various targets:

### 7.1 XState (TypeScript/JavaScript)

The natural target for web applications. Orca's statechart semantics map directly to XState's machine definitions. Actions compile to XState actions, guards to XState guards, effects to XState invoked services.

### 7.2 Embedded C

For resource-constrained environments. The flat transition table compiles to a lookup table in ROM. Actions compile to C functions. The runtime is a simple event loop with table dispatch. No dynamic allocation required.

### 7.3 Python (asyncio)

For backend services. States compile to coroutine handlers. Effects compile to awaitable tasks. The runtime uses asyncio for concurrent region execution.

### 7.4 Formal Verification (TLA+ / Alloy / Lean)

The topology can be automatically translated into formal specification languages for exhaustive verification. This enables proving properties that bounded model checking can only approximate, such as liveness under all possible interleavings of concurrent regions.

### 7.5 Visual (Mermaid / D2 / SVG)

The topology compiles to a visual state diagram. This is not just documentation — it's a primary artifact for human review. The diagram is always consistent with the executable specification because both are generated from the same source.

---

## 8. The Retro-Quest Example

To ground this in a concrete case, consider a text adventure game engine (a domain that is inherently a state machine).

### 8.1 Topology

```
machine TextAdventure

context {
  current_room: string
  inventory: string[]
  flags: map<string, bool>
  health: int = 100
  narrative_history: string[]
}

events {
  go_north, go_south, go_east, go_west
  look, take, use, talk
  attack, flee
  game_over_trigger
}

state exploring [initial] {
  description: "Player is exploring the world"
  on_entry: -> describe_room
}

state in_conversation {
  description: "Player is talking to an NPC"
  on_entry: -> start_dialogue
}

state in_combat {
  description: "Player is in combat with an enemy"
  on_entry: -> describe_combat_start
}

state game_over [final] {
  description: "Game has ended"
  on_entry: -> describe_ending
}

transitions {
  exploring       + go_north  [north_exit_exists]   -> exploring         : move_north
  exploring       + go_south  [south_exit_exists]    -> exploring         : move_south
  exploring       + go_east   [east_exit_exists]     -> exploring         : move_east
  exploring       + go_west   [west_exit_exists]     -> exploring         : move_west
  exploring       + go_north  [!north_exit_exists]   -> exploring         : describe_no_exit
  exploring       + go_south  [!south_exit_exists]   -> exploring         : describe_no_exit
  exploring       + go_east   [!east_exit_exists]    -> exploring         : describe_no_exit
  exploring       + go_west   [!west_exit_exists]    -> exploring         : describe_no_exit
  exploring       + look                             -> exploring         : describe_room_detail
  exploring       + take      [item_present]         -> exploring         : pick_up_item
  exploring       + take      [!item_present]        -> exploring         : describe_nothing_to_take
  exploring       + talk      [npc_present]          -> in_conversation   : _
  exploring       + talk      [!npc_present]         -> exploring         : describe_nobody_here
  exploring       + attack    [enemy_present]        -> in_combat         : _
  exploring       + game_over_trigger                -> game_over         : _
  in_conversation + talk                             -> in_conversation   : continue_dialogue
  in_conversation + go_north                         -> exploring         : exit_conversation
  in_conversation + go_south                         -> exploring         : exit_conversation
  in_conversation + go_east                          -> exploring         : exit_conversation
  in_conversation + go_west                          -> exploring         : exit_conversation
  in_combat       + attack                           -> in_combat         : resolve_attack
  in_combat       + flee      [can_flee]             -> exploring         : flee_combat
  in_combat       + flee      [!can_flee]            -> in_combat         : describe_cant_flee
  in_combat       + game_over_trigger                -> game_over         : _
}
```

### 8.2 The LLM's Role

Notice what's *not* in the topology: narrative text. The `describe_room` action doesn't contain a hardcoded description — its implementation calls an LLM to generate contextual narrative based on the room data and player history. The state machine ensures the *game logic* is deterministic and correct (you can't walk north if there's no north exit, you can't flee combat when fleeing is impossible), while the *creative content* is generated dynamically.

```typescript
action describe_room(ctx: Context): Context + Effect<NarrativeRequest> {
  const request: NarrativeRequest = {
    prompt: `Describe the room: ${ctx.current_room}`,
    context: {
      inventory: ctx.inventory,
      recent_history: ctx.narrative_history.slice(-5),
      room_data: world.rooms[ctx.current_room]
    }
  }
  return [ctx, emit(request)]
}
```

This is the hybrid architecture in practice: verified state machine for control flow, LLM for creative generation within each state. The state machine guarantees that narrative context amnesia can't happen (the context is explicitly threaded), and broken spatial navigation can't happen (the guard `north_exit_exists` is a deterministic check against the world map).

---

## 9. Addressing Known Limitations

### 9.1 State Explosion

**Problem:** Complex systems can have enormous state spaces.

**Mitigation:** Hierarchical states reduce the specification size exponentially. A machine with 3 parallel regions of 4 states each has 64 combined states but only 12 state declarations. The LLM generates the compressed hierarchical form; the verifier expands it. Additionally, the context record absorbs what would otherwise be state distinctions — instead of separate states for "retry_count_0", "retry_count_1", "retry_count_2", a single state uses a guard on `ctx.retry_count`.

### 9.2 Guard Complexity

**Problem:** Guards can smuggle arbitrary computation into the topology layer.

**Mitigation:** Orca restricts guards to a decidable expression language: comparisons, boolean operators, null checks, set membership, and simple arithmetic over context fields. No function calls, no loops, no recursion. Guards that require complex logic must be computed by an action in a preceding state and stored as a boolean flag in the context. This keeps the topology verifiable while still allowing complex conditional behavior.

### 9.3 The Action Language Problem

**Problem:** Actions are written in a conventional host language, inheriting all the LLM code generation problems we're trying to avoid.

**Mitigation:** This is real, but bounded. Actions are (a) short (typically under 20 lines), (b) pure (no I/O, no global state), (c) typed (inputs and outputs are fixed), and (d) isolated (no calls to other actions). These are exactly the conditions under which LLM code generation is most reliable. The problems emerge with long, stateful, interconnected code — and Orca's architecture ensures actions are none of those things.

### 9.4 Bootstrapping the Training Data

**Problem:** No LLM has been trained on Orca, so it can't generate Orca natively.

**Mitigation:** Several complementary strategies:

1. **Zero-shot from the spec.** The Orca syntax is simple enough (and close enough to existing statechart notations) that frontier LLMs can generate it from a syntax reference included in the prompt, with no fine-tuning. This is similar to how LLMs can write XState definitions today.

2. **Transpilation corpus.** Existing codebases that use state machine patterns (XState projects, Redux state machines, embedded control systems) can be automatically converted to Orca, creating a training corpus.

3. **Self-play generation.** Use an LLM to generate Orca machines from natural language specifications, verify them, and retain the verified machines as training data. The verification pipeline acts as a filter, ensuring only correct machines enter the corpus.

4. **Incremental adoption.** Orca doesn't require abandoning existing languages. It can generate code *in* existing languages (via compilation targets). Teams can adopt it incrementally for the architectural layer while keeping their existing action code.

### 9.5 Expressiveness Ceiling

**Problem:** Not all programs are naturally expressed as state machines.

**Response:** This is true, and Orca doesn't claim to replace general-purpose programming. It targets a specific — but very large — class of programs: anything that processes events, manages workflows, implements protocols, drives UIs, or coordinates services. This includes most web applications, most embedded systems, most business processes, and most game engines. For purely computational tasks (numerical algorithms, data transformations, compilers), conventional languages remain appropriate.

The claim is not "all programs should be state machines" but rather "the architectural skeleton of most interactive systems is a state machine, and generating that skeleton reliably is more valuable than generating the whole program unreliably."

---

## 10. Comparison to Alternatives

| Approach | Topology Verification | Action Isolation | Generation Difficulty | Expressiveness | Training Data |
|---|---|---|---|---|---|
| Python | None (runtime only) | None | Low | High | Abundant |
| TypeScript | Partial (type system) | None | Low | High | Abundant |
| Rust | Strong (type + borrow) | Partial | High | High | Limited |
| Prolog | Logical consistency | N/A | Medium | Medium (logic) | Scarce |
| MoonBit | Type system + sampler | None | Medium | High | Scarce |
| Lean/Dafny | Full formal verification | None | Very high | Medium | Very scarce |
| **Orca** | **Full (graph + SAT)** | **Complete** | **Low (flat table)** | **Medium (event-driven)** | **Bootstrappable** |

Orca's unique position is the combination of full topology verification, complete action isolation, and low generation difficulty. It trades expressiveness (it only captures event-driven systems) for dramatically stronger guarantees about the generated code's structural correctness.

---

## 11. Implementation Roadmap

### Phase 1: Core Language and Verifier
- Orca parser (flat transition tables, no hierarchy)
- Topology verifier (completeness, reachability, determinism, deadlock)
- XState compilation target
- Visual diagram output (Mermaid)

### Phase 2: LLM Integration
- Prompt templates for topology generation
- Two-phase generation pipeline with verification feedback loops
- Action generation with auto-generated unit tests
- Benchmark: compare LLM success rates for Orca vs. direct XState generation

### Phase 2.5: Orca CLI Skills

To make Orca adoption seamless for LLMs, the CLI exposes structured skills that wrap verification and compilation. Each skill is designed for LLM consumption with structured output suitable for iterative refinement.

#### Skill: `/generate-orca`
Converts a natural language description into an Orca topology.

**Input:** Natural language specification (e.g., "A payment processor that handles retries up to 3 times")

**Output:** Complete `.orca` file with:
- Machine declaration and context type
- Event vocabulary
- State declarations with `[initial]`/`[final]` markers
- Transition table with guards
- Action signatures (without implementations)

**Structured response:**
```json
{
  "status": "success" | "error",
  "machine": "<.orca file content>",
  "verification": { "passed": true } | { "passed": false, "errors": [...] }
}
```

#### Skill: `/verify-orca`
Runs the full verification pipeline and returns structured feedback.

**Input:** Path to `.orca` file

**Output:** Structured verification result:
```json
{
  "status": "valid" | "invalid",
  "machine": "PaymentProcessor",
  "states": 7,
  "events": 8,
  "transitions": 11,
  "errors": [
    {
      "code": "INCOMPLETE_EVENT_HANDLING",
      "message": "State 'idle' does not handle event 'payment_authorized'",
      "location": { "state": "idle", "event": "payment_authorized" },
      "suggestion": "Add transition: idle + payment_authorized -> <target> : <action>"
    }
  ]
}
```

**Error codes designed for LLM feedback loops:**
- `UNREACHABLE_STATE` - Add incoming transition
- `DEADLOCK` - Add outgoing transitions or mark as `[final]`
- `INCOMPLETE_EVENT_HANDLING` - Add transition for missing (state, event) pair
- `NON_DETERMINISTIC` - Make guards mutually exclusive
- `ORPHAN_EVENT` - Remove unused event declaration
- `ORPHAN_ACTION` - Remove unused action signature

#### Skill: `/compile-orca`
Compiles Orca to target format with structured output.

**Input:** Path to `.orca` file, target (`xstate` | `mermaid`)

**Output:**
```json
{
  "status": "success" | "error",
  "target": "xstate",
  "output": "// Compiled XState v5 machine...",
  "warnings": []
}
```

#### Skill: `/generate-actions`
Given a verified Orca topology, generates action implementations.

**Input:** Path to verified `.orca` file, target language

**Output per action:**
```json
{
  "action": "increment_retry",
  "signature": "(ctx: Context) -> Context",
  "context_used": ["retry_count"],
  "generated_code": "action increment_retry(ctx: Context): Context { ... }",
  "unit_tests": [
    { "name": "increments retry_count by 1", "input": "ctx.retry_count = 0", "expected": "ctx.retry_count = 1" }
  ]
}
```

**Structured response:**
```json
{
  "status": "success" | "error",
  "actions": [
    { "name": "increment_retry", "generated": true, "tests_passed": true },
    { "name": "send_authorization_request", "generated": false, "error": "..." }
  ]
}
```

#### Skill: `/refine-orca`
Given verification errors, produces a corrected Orca topology.

**Input:** Current `.orca` file, verification errors from `/verify-orca`

**Output:** Corrected `.orca` file with changes that address the errors

**Approach:** The skill receives:
1. Original Orca source
2. Structured verification errors
3. The error messages are designed to be directly actionable by an LLM

This enables the feedback loop:
```
/generate-orca → /verify-orca → /refine-orca → /verify-orca → /compile-orca
```

#### Skill Invocation Examples

```
/generate-orca "A simple toggle that tracks how many times it's been flipped"
→ produces simple-toggle.orca

/verify-orca examples/payment-processor.orca
→ { "status": "invalid", "errors": [...] }

.refine-orca examples/payment-processor.orca --errors '[{"code": "DEADLOCK", "state": "declined"}]'
→ produces corrected version

/compile-orca examples/payment-processor.orca xstate
→ { "target": "xstate", "output": "..." }

/generate-actions examples/payment-processor.orca typescript
→ { "actions": [...] }
```

#### LLM Integration Architecture

The skills use a pluggable architecture for LLM providers and code generators:

**Supported LLM Providers:**
- `anthropic` — Claude models (claude-sonnet-4-6, claude-opus-4-6, claude-haiku-4-5)
- `openai` — GPT models (GPT-4o, GPT-4.5, etc.)
- `grok` — xAI's Grok models (grok-3, etc.)
- `ollama` — Local models via Ollama (llama3, mistral, etc.)

**Code Generators:**
- `typescript` — Primary target for action implementation generation
- `python` — Python action implementations
- `rust` — Rust action implementations
- `go` — Go action implementations

**Configuration Hierarchy:**

LLM and code generator settings are loaded from YAML config files with precedence:
1. Global default: `~/.orca/default.yaml`
2. Project config: `./orca.yaml` or `./.orca.yaml` or `./orca/orca.yaml`

Example `orca.yaml`:
```yaml
provider: anthropic
model: claude-sonnet-4-6
code_generator: typescript
max_tokens: 4096
temperature: 0.7
```

Environment variables are supported via `${VAR_NAME}` interpolation:
```yaml
provider: anthropic
api_key: ${ANTHROPIC_API_KEY}
```

**Directory Structure for LLM Integration:**
```
src/
├── config/
│   ├── types.ts      # OrcaConfig, LLMProviderType, CodeGeneratorType
│   └── loader.ts     # YAML config loading with env var interpolation
├── llm/
│   ├── provider.ts   # LLMProvider interface
│   ├── anthropic.ts  # Anthropic API implementation
│   ├── openai.ts    # OpenAI API implementation
│   ├── grok.ts      # xAI Grok API implementation
│   └── ollama.ts    # Ollama local model implementation
└── generators/
    ├── registry.ts   # CodeGenerator registry
    └── typescript.ts # TypeScript code generator
```

### Phase 3: Advanced Features
- Hierarchical states and parallel regions
- Property specification and bounded model checking
- Additional compilation targets (Python, C, Lean)
- IDE integration with live verification

### Phase 4: Ecosystem
- Orca package registry (reusable machine fragments)
- Visual editor with bidirectional sync to Orca source
- Fine-tuning dataset from verified machines
- Multi-machine composition (machines as components)

---

## 12. Conclusion

The fundamental insight of Orca is that the architecture of a program and its computation are different problems with different verification strategies, and an LLM should generate them separately. By choosing state machines as the architectural representation, we gain access to decades of formal verification theory applied to a representation that LLMs can produce reliably. By isolating actions as small, pure, typed functions, we constrain the computational problem to the regime where LLMs are already demonstrably competent.

Orca doesn't solve the LLM code generation problem in general. It solves it for the class of programs where getting the architecture right matters more than getting every line of code right — which, in practice, is most of the software that matters.

---

*Orca is a working proposal. The name, syntax, and specific design decisions are open for revision. The core architectural claim — that separating topology from computation enables dramatically more reliable LLM code generation — is the contribution.*
