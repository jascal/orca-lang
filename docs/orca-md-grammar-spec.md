# Orca Markdown Grammar Specification

This document is the authoritative grammar reference for `.orca.md` files.

## Overview

Orca is a markdown-based state machine language. Machine definitions use standard markdown: headings, tables, bullet lists, and blockquotes.

## File Structure

```
# machine MachineName

## context
| Field  | Type    | Default |
|--------|---------|---------|
| field1 | string  |         |

## events
- event1
- event2

## state Name [initial|final]
> Description
- on_entry: action
- on_exit: action
- timeout: 5s -> target
- ignore: event1, event2

## transitions
| Source | Event | Guard | Target | Action |

## guards
| Name | Expression |

## actions
| Name | Signature |
```

## Critical Syntax Rules

1. **Initial state**: MUST use `[initial]` in the heading: `## state stateName [initial]`
   - There is NO alternative syntax. Never use "initial: true" or any other form.

2. **Final state**: MUST use `[final]` in the heading: `## state stateName [final]`
   - There is NO alternative syntax. Never use "final: true" or any other form.

3. **Every state referenced in transitions MUST have a `## state` heading declared.**

## Section Reference

### `# machine Name`

Required first line. Defines the machine name.

### `## context`

Optional. Defines context fields (machine state data).

| Column | Required | Description |
|--------|----------|-------------|
| Field  | Yes      | Field name (identifier) |
| Type   | Yes      | Type: `string`, `int`, `decimal`, `bool`, `string?` (optional) |
| Default | No      | Default value |

### `## events`

Required. Lists all events this machine handles.

```markdown
## events
- event1
- event2
- event3
```

### `## state Name [initial|final]`

Defines a state. The `[initial]` or `[final]` annotation is required for exactly one initial state and any number of final states.

```markdown
## state idle [initial]
> Description of this state
- on_entry: action_name
- on_exit: action_name
- timeout: 5s -> target_state
- ignore: event1, event2
```

**State modifiers:**
- `> text` — Blockquote description
- `on_entry: action` — Action to run on state entry
- `on_exit: action` — Action to run on state exit
- `timeout: Ns -> target` — Timeout transition after N seconds
- `ignore: event1, event2` — Events to ignore in this state

### `## transitions`

Required. Markdown table defining state transitions.

| Column  | Required | Description |
|---------|----------|-------------|
| Source  | Yes      | Source state name |
| Event   | Yes      | Event that triggers transition |
| Guard   | No       | Guard name (from ## guards table), prefix `!` to negate |
| Target  | Yes      | Target state name |
| Action  | No       | Action to execute on transition |

```markdown
## transitions
| Source | Event  | Guard  | Target | Action  |
|--------|--------|--------|--------|---------|
| idle   | event1 |        | active | action1 |
| active | event2 | guard1 | done   | action2 |
| active | event2 | !guard1| idle   |         |
```

### `## guards`

Optional. Defines named guard expressions.

| Column     | Required | Description |
|------------|----------|-------------|
| Name       | Yes      | Guard identifier (used in transitions) |
| Expression | Yes      | Expression in backticks |

**Supported expressions:**
- Comparisons: `<`, `>`, `==`, `!=`, `<=`, `>=`
- Null checks: `== null`, `!= null`
- Boolean operators: `and`, `or`, `not`

**NOT supported:**
- Method calls: `.contains()`, `.includes()`, `.length()`, etc.
- Array indexing beyond null checks

### `## actions`

Optional. Declares action signatures (not implementations).

| Column    | Required | Description |
|-----------|----------|-------------|
| Name      | Yes      | Action identifier |
| Signature | Yes      | Type signature in backticks |

**Signature format:**
- Plain action: `` `(ctx) -> Context` ``
- Action with event: `` `(ctx, event) -> Context` ``
- Effect action: `` `(ctx) -> Context + Effect<T>` ``

## Multi-Machine Files

Separate machines with `---` on its own line:

```markdown
# machine Coordinator

## state delegating [initial]
- invoke: WorkerMachine
- on_done: done_state
- on_error: error_state

---

# machine WorkerMachine

## state working [initial]
## state done [final]
```

**Invocation rules:**
- `invoke: MachineName` — Start child machine on state entry
- `on_done: target` — Transition when child reaches `[final]`
- `on_error: target` — Transition on child error
- Each state may invoke at most one child machine
- Circular invocations (A invokes B invokes A) are not allowed
- Child machines must have at least one `[final]` state

## Type System

### Primitive Types
- `string` — Text values
- `int` — Integer numbers
- `decimal` — Decimal numbers
- `bool` — Boolean (true/false)

### Complex Types
- `string?` — Optional string
- `Field[]` — Array of Field

### Context Access
- Guards access context via `ctx.fieldName`
- Actions receive `ctx` as first parameter
- Events provide `event` payload as second parameter (if used in signature)

## Transitions

### Transition Execution Order

1. Guard evaluation (if present)
2. Action execution
3. State change

### Timeout Transitions

```markdown
## state processing
> Processing with timeout
- timeout: 30s -> failed
```

Timeouts are cancelled if the state is exited before they fire.

### Ignore Lists

```markdown
## state idle [initial]
> Waiting
- ignore: event1, event2
```

Ignored events are silently consumed without causing a deadlock.

## Effects

Effects represent side effects (I/O, API calls, etc.).

### Effect Declaration

```markdown
## effects
| Type         | Description |
|--------------|-------------|
| ChargeCard   | Charge a payment card |
| SendEmail    | Send an email notification |
```

### Effect Actions

```markdown
## actions
| Name        | Signature |
|-------------|-----------|
| charge_card | `(ctx) -> Context + Effect<ChargeCard>` |
```

### Effect Handling

Effects are emitted during transitions and handled by the runtime:

```typescript
machine.onEffect('ChargeCard', async (payload) => {
  return await paymentGateway.charge(payload.amount);
});
```

## Property Specification

Optional properties declare machine behavior:

```markdown
## properties
| Type      | Expression |
|-----------|------------|
| reachable | processing |
| exclusion | idle, done |
```

**Property types:**
- `reachable` — State must be reachable
- `unreachable` — State must NOT be reachable
- `exclusion` — States are mutually exclusive
- `passes_through` — Execution path must pass through state
- `live` — State must remain reachable
- `responds` — Event must eventually be handled
- `invariant` — Condition must always hold

## Complete Example

```markdown
# machine OrderProcessor

## context

| Field    | Type    | Default |
|----------|---------|---------|
| orderId  | string  |         |
| retries  | int     | 0       |
| error    | string? |         |

## events

- submit
- payment_ok
- payment_failed
- retry
- cancel

## state idle [initial]
> Waiting for an order to be submitted
- ignore: payment_ok, payment_failed, retry

## state processing
> Processing the payment
- on_entry: start_payment
- timeout: 30s -> failed

## state done [final]
> Order complete

## state failed
> Payment failed
- ignore: submit, payment_ok

## transitions

| Source     | Event          | Guard     | Target     | Action          |
|------------|----------------|-----------|------------|-----------------|
| idle       | submit         |           | processing | init_order      |
| idle       | cancel         |           | idle       |                 |
| processing | payment_ok     |           | done       | complete_order  |
| processing | payment_failed | can_retry | failed     | record_error    |
| processing | payment_failed | !can_retry| failed     | record_error    |
| processing | cancel         |           | idle       | cancel_order    |
| failed     | retry          | can_retry | processing | increment_retry |
| failed     | cancel         |           | idle       | cancel_order    |

## guards

| Name      | Expression         |
|-----------|--------------------|
| can_retry | `ctx.retries < 3`  |

## actions

| Name             | Signature                          |
|------------------|------------------------------------|
| init_order       | `(ctx, event) -> Context`          |
| start_payment    | `(ctx) -> Context + Effect<ChargeCard>` |
| complete_order   | `(ctx, event) -> Context`          |
| record_error     | `(ctx, event) -> Context`          |
| increment_retry  | `(ctx) -> Context`                 |
| cancel_order     | `(ctx) -> Context`                 |
```

## Common Errors

| Code | Cause | Fix |
|------|-------|-----|
| NO_INITIAL_STATE | No `[initial]` state | Add `[initial]` to exactly one state heading |
| UNREACHABLE_STATE | State never entered | Check transition paths |
| DEADLOCK | State/event not handled | Add transition or `ignore:` |
| NON_DETERMINISTIC | Conflicting guards | Make guards mutually exclusive |
| ORPHAN_ACTION | Action not used | Remove or add transition |
| PARSE_ERROR | Invalid syntax | Check markdown formatting |

## File Extension

Use `.orca.md` for Orca markdown files.

## See Also

- [AGENTS.md](../AGENTS.md) — Agent integration guide
- [examples/](examples/) — Example machine definitions
