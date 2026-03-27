# Machine Invocation: State Machines Calling Other State Machines

## Problem Statement

Orca currently supports hierarchical states (nested states) and parallel regions (multiple independent state machines within a compound state). However, there is no mechanism for one state machine to **invoke** another state machine as part of its behavior — where the child machine runs to completion (or produces a result) before the parent continues.

This is fundamental for:
- **Modular state machine design** — reusable sub-machines (validation, authentication, payment processing)
- **Complex workflows** — a parent machine orchestrates multiple child machines
- **Separation of concerns** — isolate error handling, retry logic, or complex substates into child machines

---

## Current Architecture

### What Exists

| Feature | How It Works |
|---------|--------------|
| **Hierarchical states** | `StateDef.contains[]` — nested states, parent transitions fire from children |
| **Parallel regions** | `StateDef.parallel.regions[]` — multiple independent state machines in one parent |
| **Effects** | `ActionSignature.hasEffect: true` + `effectType` — async ops routed via event bus |
| **Event bus** | `requestResponse()` — inter-machine communication via events |
| **Timeouts** | `StateDef.timeout: { duration, target }` — auto-transition after duration |

### What Does NOT Exist

- No `invoke` or `call` field on `Transition` or `StateDef`
- No way to start one machine from within another
- No way to wait for a child machine to complete
- No parent-child lifecycle management

### Relevant Existing Patterns

**Effect pattern** (`ActionSignature.hasEffect`):
```typescript
// Actions declare async side effects with typed results
interface ActionSignature {
  name: string;
  returnType: string;
  hasEffect: boolean;
  effectType?: string;  // e.g., "PaymentCharge"
}
```

**XState invoke for effects** (`xstate.ts`):
```typescript
// Effects use __effect__: prefix, replaced with fromPromise at runtime
config.invoke = {
  src: `__effect__:${effectType}`,
  input: ({ context, event }) => ({ context, event }),
  onDone: { target: doneTarget },
  onError: { target: errorTarget },
};
```

---

## Design: State-Level Invoke

### Recommendation

Add `invoke` to `StateDef`, not `Transition`. When the state is entered, start the child machine; when the child completes or errors, emit an event to continue the parent.

This mirrors XState's state-level `invoke` and aligns with the existing effect invocation pattern.

### Scope: Single-File Multi-Machine

For v1, all machines (parent and invoked children) must be defined in the **same `.orca.md` file**, separated by `# machine Name` headings. Multi-file imports are deferred to a later phase.

### Proposed Syntax

```md
# machine OrderProcessor

## context

| Field | Type |
|-------|------|
| order_id | string |

## events

- VALIDATED
- VALIDATION_FAILED

## state validating [initial]
> Validating order with sub-machine
- invoke: OrderValidator
- on_done: VALIDATED
- on_error: VALIDATION_FAILED

## state validated
> Order is valid

## state validation_failed [final]
> Validation failed

## transitions

| Source | Event | Target |
|--------|-------|--------|
| validating | VALIDATED | validated |
| validating | VALIDATION_FAILED | validation_failed |

---

# machine OrderValidator

## context

| Field | Type |
|-------|------|
| order_id | string |

## state checking [initial]
> Checking order validity

## state valid [final]
> Order is valid

## state invalid [final]
> Order is invalid

## transitions

| Source | Event | Target |
|--------|-------|--------|
| checking | VALID | valid |
| checking | INVALID | invalid |
```

### With Inline Input Mapping

```md
## state validating
> Validating order
- invoke: OrderValidator input: { id: ctx.order_id }
- on_done: VALIDATED
- on_error: VALIDATION_FAILED
```

Only one `invoke:` bullet is allowed per state. For concurrent invocations, use parallel regions (see Design Decisions §3).

---

## Design Decisions

The following questions were resolved during design review. Each decision is grounded in existing codebase patterns.

### 1. Lifecycle Ownership — Parent owns children completely

The parent owns the child's lifecycle. When the parent stops or exits the invoking state, all children are forcibly stopped. No orphan children.

This matches how parallel regions work — regions die when the parent state exits (timeouts cancelled, state value replaced). XState v5 behaves the same way.

**Snapshot/restore interaction**: The parent's snapshot includes child machine snapshots nested inside it:

```typescript
snapshot(): MachineSnapshot {
  return {
    state: ...,
    context: ...,
    children: Object.fromEntries(
      [...this.childMachines].map(([k, m]) => [k, m.snapshot()])
    ),
    timestamp: Date.now(),
  };
}
```

On restore, child machines are re-created from their snapshots. Action handlers must be re-registered (same as existing snapshot/restore behavior).

### 2. Context Isolation — Input-only

Child machines receive mapped input and run with their own independent context. They do **not** share the parent's context.

This matches the existing effect pattern: effects receive `{ context, event }` as input and return `EffectResult.data` that gets merged back. Machine invocation follows the same contract:

```
Parent context → input mapping → child context (independent) → child reaches final state → result returned → parent merges
```

Shared context would make verification impossible (concurrent mutations). Full isolation wastes data if the child only needs a subset. Input-only is the right balance.

### 3. Concurrency with Parallel Regions — Use regions for concurrency

An invoke lives on a state. If that state is inside a parallel region, only that region blocks while the child runs. Other regions continue processing events independently.

**Multiple invocations on a single state are not allowed.** If concurrent invocations are needed, use a parallel state with one invoke per region:

```md
## state processing [parallel]
- on_done: -> completed

### region payment
#### state charging [initial]
- invoke: PaymentProcessor
- on_done: CHARGED
#### state charged [final]

### region notification
#### state notifying [initial]
- invoke: NotificationService
- on_done: NOTIFIED
#### state notified [final]
```

This reuses existing parallel sync strategies (`all-final`, `any-final`) without introducing a new coordination primitive. The parser rejects multiple `invoke:` bullets on a single state.

### 4. Error Boundaries — Propagate as event, require on_error

Unhandled child errors propagate as the `on_error` event to the parent. This matches how effects work — `executeEffect` catches exceptions and returns `{ status: "failure" }`.

Two distinct completion modes:
- **Child reaches a final state** → `on_done` fires on parent, regardless of *which* final state. The parent receives `{ finalState, context }` as event output to distinguish outcomes.
- **Child throws an unhandled exception** → `on_error` fires on parent.

If `on_error` is not declared, the verifier warns (potential deadlock — same detection as `findDeadlockStates()`). The parent stays stuck in the invoking state.

**Important nuance**: A child with both `valid [final]` and `invalid [final]` states fires `on_done` in *both* cases. The parent should route based on `event.output.finalState`:

```typescript
// In the on_done handler, parent can inspect which final state:
// event.output = { finalState: "valid", context: { ... } }
// event.output = { finalState: "invalid", context: { ... } }
```

### 5. Cancellation — Forced on state exit

If the parent transitions away from the invoking state before the child completes, the child is stopped immediately. Forced, not cooperative. This mirrors timeout cancellation behavior (`cancelTimeout()` on state exit).

The exit path becomes:
```typescript
private async exitState(stateName: string): Promise<void> {
  this.cancelTimeout();
  await this.stopChildMachine(stateName);  // New
  await this.executeExitActions(stateName);
}
```

**Timeout interaction**: If the invoking state has a `timeout`, the timeout fires and transitions the parent away, which kills the child. Timeouts act as invocation deadlines for free.

No cooperative cancellation in v1.

### 6. Recursive Invocations — Disallowed in v1

Both self-recursion (`A invokes A`) and mutual recursion (`A invokes B invokes A`) are disallowed. The verifier detects cycles in the invocation graph and rejects them.

Implementation: build a directed graph of machine→invoked-machine edges and check for cycles (same graph analysis pattern used for reachability and deadlock detection).

Recursion with depth limits is a potential v2 feature but adds significant complexity to both runtime and verification.

### 7. Type System Integration — Separate from effects

Machine invocation is a separate concern from the effect system. Effects are for async I/O (API calls, DB queries). Invocations are for orchestration of stateful sub-machines.

Key differences:
- **Lifecycle**: Effects are fire-and-forget promises; invocations are stateful actors with their own state machine
- **Verification**: Effects aren't verifiable; invoked machines are fully analyzed by the verifier
- **Cancellation**: Effects may not be cancellable; machines always are

The XState compiler uses `__machine__:Name` in the `src` field (parallel to `__effect__:Type`). Clean separation.

The invocation *result*, however, follows the same shape as effect results for consistency:

```typescript
interface InvocationResult {
  status: "success" | "failure";
  data?: Record<string, unknown>;  // Child's final context (or mapped subset)
  finalState?: string;             // Which final state the child reached
  error?: string;
}
```

### 8. Return Values — Final state + context

Child machines return `{ finalState: string, context: Record<string, unknown> }`. The parent receives this as `event.output` in the `on_done` handler.

This is the simplest useful return value:
- `finalState` tells the parent *which* outcome occurred (e.g., `valid` vs `invalid`)
- `context` provides any data the child computed

The parent can then route based on `finalState` or extract specific fields from the child's context via action handlers.

### 9. Multiple Simultaneous Invocations — Use parallel regions

Not supported as a first-class feature. Use parallel regions instead (see Decision §3). The parser rejects multiple `invoke:` bullets on a single state.

---

## Required Changes

### 1. AST (`ast.ts`)

```typescript
// New field on StateDef
interface StateDef {
  // ... existing fields ...
  invoke?: InvokeDef;
}

// New InvokeDef type
interface InvokeDef {
  machine: string;                   // Name of machine to invoke
  input?: Record<string, string>;    // Optional: ctx.field -> child param mapping
  onDone?: string;                   // Event to emit when child completes
  onError?: string;                  // Event to emit when child errors
}

// Multi-machine file support
interface OrcaFile {
  machines: MachineDef[];            // Multiple machines in one file
}
```

Note: the previously proposed `## invocations` table and `InvocationDef`/`MachineDef.invocations` are dropped. The state-level `invoke:` bullet is sufficient and avoids redundancy.

### 2. Markdown Parser

Handle new bullet items and multi-machine files:
```typescript
// Multi-machine: split on `# machine Name` headings
// Each heading starts a new MachineDef

// State-level invoke bullet:
else if (text.startsWith("invoke:")) {
  const rest = text.slice(7).trim();
  // Parse: "MachineName" or "MachineName input: { field: ctx.field }"
  // Only one invoke per state (reject duplicates)
}
```

### 3. XState Compiler

```typescript
// In buildStateConfig for states with invoke:
if (state.invoke) {
  config.invoke = {
    src: `__machine__:${state.invoke.machine}`,
    input: ({ context, event }) => evaluateMapping(state.invoke.input, context),
    onDone: state.invoke.onDone
      ? { target: resolveTarget(state.invoke.onDone) }
      : undefined,
    onError: state.invoke.onError
      ? { target: resolveTarget(state.invoke.onError) }
      : undefined,
  };
}
```

### 4. Runtime-ts (`machine.ts`)

```typescript
export class OrcaMachine {
  // ... existing fields ...
  private childMachines: Map<string, OrcaMachine> = new Map();
  private siblingMachines?: Map<string, MachineDef>;  // Other machines in file

  // Register sibling machines available for invocation
  registerMachines(machines: Map<string, MachineDef>): void;

  // On state entry with invoke:
  private async startChildMachine(stateName: string, invokeDef: InvokeDef): Promise<void> {
    // 1. Resolve machine name from siblingMachines
    // 2. Map input from parent context
    // 3. Create child OrcaMachine with mapped context
    // 4. Register completion listener (child reaches final state -> emit onDone)
    // 5. Register error listener (child throws -> emit onError)
    // 6. Start child
  }

  // On state exit (cancellation):
  private async stopChildMachine(stateName: string): Promise<void> {
    // 1. Stop child machine
    // 2. Remove from childMachines map
  }

  // Snapshot includes children:
  snapshot(): MachineSnapshot {
    return {
      state: ...,
      context: ...,
      children: Object.fromEntries(
        [...this.childMachines].map(([k, m]) => [k, m.snapshot()])
      ),
      timestamp: Date.now(),
    };
  }
}
```

### 5. Runtime-python (`machine.py`)

Same architecture as runtime-ts. After TS implementation is validated:
- Add `child_machines: dict[str, OrcaMachine]` and `sibling_machines: dict[str, MachineDef]`
- Child start/stop in `_execute_entry_actions` / `_exit_state`
- Snapshot includes children
- Async child completion via `asyncio.create_task`

### 6. Verifier Updates

**Cross-machine analysis** (critical for correctness):

| Check | Description |
|-------|-------------|
| **Machine resolution** | `invoke.machine` must reference a machine defined in the same file |
| **Circular invocation detection** | Build invocation digraph, reject cycles (self and mutual recursion) |
| **Child reachability to final** | Invoked machine must have at least one reachable final state (otherwise parent deadlocks) |
| **on_done/on_error declared** | Events referenced by invoke must exist in parent's event list |
| **Missing on_error warning** | Warn if invoke has no on_error (potential deadlock on child failure) |
| **Size limits** | Invoked machine states count toward total state budget (64 states) |
| **Input field validation** | Fields referenced in `input:` mapping must exist in parent context |

---

## Alternative Approaches (Rejected)

### Option B: Transition-Level Invoke

Add `invoke` directly on `Transition`:

```md
| Source | Event | Target | Action |
|--------|-------|--------|--------|
| idle | validate | validating | invoke: validator |
```

**Rejected because**: Mixes action and invocation semantics. Invocations are stateful actors, not fire-and-forget actions. State-level invoke aligns with XState and makes lifecycle management clear.

### Option C: Action-Level Invoke

Extend `ActionSignature` with a new return type:

```md
## actions

| Name | Signature |
|------|-----------|
| validate | `(ctx) => Context + Invoke<OrderValidator>` |
```

**Rejected because**: Requires significant type system changes. Invocation should be a separate concern from effects (different lifecycle, different verification, different cancellation).

---

## XState v5 Reference

XState v5 supports state-level `invoke`:

```javascript
{
  states: {
    validating: {
      invoke: {
        src: 'OrderValidator',  // machine name or actor
        input: ({ context, event }) => ({ orderId: context.orderId }),
        onDone: { target: 'validated' },
        onError: { target: 'validation_failed' }
      },
      on: {
        done: { target: 'validated' },  // XState fires this automatically
        error: { target: 'validation_failed' }
      }
    }
  }
}
```

Key XState concepts:
- `src` can be a string (actor/machine reference) or `fromPromise`/`fromCallback`
- `onDone` uses done state semantics when child reaches a final state
- `onError` catches exceptions and failed promises
- Actors are spawned with `from` and cleaned up when parent stops

---

## Implementation Plan

### Step 1: AST + Parser (single-file multi-machine)

- Add `InvokeDef` to AST types
- Add `OrcaFile` wrapper for multi-machine files
- Parse `# machine Name` as file-level machine separator
- Parse `- invoke:`, `- on_done:`, `- on_error:` bullets on state
- Reject multiple `invoke:` bullets per state
- Add multi-machine example file

### Step 2: Verifier — cross-machine analysis

- Resolve `invoke.machine` references across machines in the same file
- Build invocation digraph and detect cycles
- Verify invoked machines can reach a final state
- Validate on_done/on_error events are declared
- Warn on missing on_error
- Enforce combined state budget across all machines

### Step 3: Runtime-ts invocation

- Add `childMachines` and `siblingMachines` to `OrcaMachine`
- Start child on state entry (resolve machine, map input, create instance)
- Stop child on state exit (forced cancellation)
- Emit on_done with `{ finalState, context }` when child reaches final state
- Emit on_error when child throws
- Include children in snapshot/restore
- Tests: basic invoke, input mapping, cancellation on exit, timeout as deadline, snapshot with children

### Step 4: XState compiler

- Emit `invoke` config with `__machine__:Name` src convention
- Generate `onDone`/`onError` targets
- Include invoked machine definitions in output metadata

### Step 5: Runtime-python

- Port runtime-ts invocation to Python async
- Same lifecycle, cancellation, and snapshot semantics
- Tests matching runtime-ts coverage

### Step 6: Demo + documentation

- Add invocation example to `examples/`
- Update skill prompts to support multi-machine generation
- Update grammar spec

---

## Example Use Cases

### Validation Sub-Machine (single file)
```md
# machine OrderProcessor

## context

| Field | Type |
|-------|------|
| order_id | string |
| is_valid | boolean |

## events

- VALIDATED
- INVALID

## state validating [initial]
> Validating order with sub-machine
- invoke: OrderValidator input: { id: ctx.order_id }
- on_done: VALIDATED
- on_error: INVALID

## state processing
> Processing validated order

## state rejected [final]
> Order rejected

## transitions

| Source | Event | Target |
|--------|-------|--------|
| validating | VALIDATED | processing |
| validating | INVALID | rejected |

---

# machine OrderValidator

## context

| Field | Type |
|-------|------|
| id | string |

## events

- VALID
- INVALID

## state checking [initial]
> Checking order validity

## state valid [final]
> Order is valid

## state invalid [final]
> Order is invalid

## transitions

| Source | Event | Target |
|--------|-------|--------|
| checking | VALID | valid |
| checking | INVALID | invalid |
```

### Authentication Flow
```md
# machine SecureAction

## state authenticating
- invoke: AuthService input: { user: ctx.user_id }
- on_done: AUTHENTICATED
- on_error: AUTH_FAILED
```

### Payment with Retry (timeout as deadline)
```md
# machine PaymentProcessor

## state processing
- invoke: PaymentGateway
- on_done: SUCCESS
- on_error: RETRYING
- timeout: 30s -> timed_out

## state retrying
- timeout: 5s -> processing

## state timed_out [final]
> Payment timed out after 30s
```

### Concurrent Invocations via Parallel Regions
```md
# machine OrderFulfillment

## state fulfilling [parallel]
- on_done: -> completed

### region payment
#### state charging [initial]
- invoke: PaymentProcessor
- on_done: CHARGED
#### state charged [final]

### region notification
#### state notifying [initial]
- invoke: NotificationService
- on_done: NOTIFIED
#### state notified [final]

## state completed [final]
> Order fulfilled
```

---

*Design reviewed 2026-03-26. Open questions resolved. Ready for Phase 4 implementation.*
