# Orca Error Catalog

Reference for all verifier error and warning codes. Each entry includes severity, the trigger condition, the fix, and a minimal example.

Codes are emitted by `orca verify`, `orca /verify-orca`, and the `verify_machine` MCP tool.

---

## Table of Contents

| Category | Codes |
|----------|-------|
| [Structural](#structural) | `NO_INITIAL_STATE`, `UNREACHABLE_STATE`, `FINAL_STATE_OUTGOING`, `DEADLOCK` |
| [Orphans](#orphans) | `ORPHAN_EVENT`, `ORPHAN_ACTION`, `ORPHAN_EFFECT`, `UNDECLARED_EFFECT` |
| [Completeness](#completeness) | `INCOMPLETE_EVENT_HANDLING` |
| [Determinism](#determinism) | `NON_DETERMINISTIC`, `GUARD_EXHAUSTIVENESS` |
| [Properties](#properties) | `PROPERTY_REACHABILITY_FAIL`, `PROPERTY_EXCLUSION_FAIL`, `PROPERTY_PATH_FAIL`, `PROPERTY_LIVENESS_FAIL`, `PROPERTY_RESPONSE_FAIL`, `PROPERTY_INVARIANT_ADVISORY`, `PROPERTY_INVARIANT_INVALID`, `PROPERTY_AMBIGUOUS_STATE`, `PROPERTY_INVALID_STATE` |
| [Multi-machine](#multi-machine) | `CIRCULAR_INVOCATION`, `UNKNOWN_MACHINE`, `CHILD_NO_FINAL_STATE`, `UNKNOWN_ON_DONE_EVENT`, `UNKNOWN_ON_ERROR_EVENT`, `MISSING_ON_ERROR`, `INVALID_INPUT_MAPPING`, `STATE_LIMIT_EXCEEDED` |
| [Size](#size) | `MACHINE_TOO_LARGE` |

---

## Structural

### `NO_INITIAL_STATE`

**Severity**: error
**Message**: `Machine has no initial state`

**Cause**: No state in the machine is marked with `[initial]`. The verifier cannot determine where execution begins.

**Fix**: Add `[initial]` to exactly one state.

```markdown
# machine Toggle

## state off [initial]   ← add [initial]
## state on [final]
```

---

### `UNREACHABLE_STATE`

**Severity**: error
**Message**: `State 'X' is unreachable from initial state 'Y'`

**Cause**: There is no sequence of transitions that leads from the initial state to `X`.

**Fix**: Add a transition that reaches `X`, or remove `X` if it is not needed.

```markdown
## transitions

| Source | Event  | Target |
|--------|--------|--------|
| idle   | START  | active |
# 'done' is never a target — it's unreachable
```

---

### `FINAL_STATE_OUTGOING`

**Severity**: error
**Message**: `Final state 'X' has outgoing transitions`

**Cause**: A state marked `[final]` has transitions listed in the transitions table that point to other states. Final states are terminal — they cannot have outgoing transitions.

**Fix**: Remove the transitions from `X`, or remove the `[final]` annotation.

---

### `DEADLOCK`

**Severity**: error
**Message**: `Non-final state 'X' has no outgoing transitions`

**Cause**: `X` is not marked `[final]` but has no transitions. The machine can enter this state and become permanently stuck.

**Fix**: Either add transitions out of `X` (perhaps a timeout or an error event), or mark it `[final]` if it is truly a terminal state.

---

## Orphans

### `ORPHAN_EVENT`

**Severity**: warning
**Message**: `Event 'X' is declared but never used in any transition`

**Cause**: `X` appears in the `## events` list but is not referenced in the transitions table and is not in any state's `ignore:` list.

**Fix**: Add a transition that uses `X`, or remove it from the events list.

---

### `ORPHAN_ACTION`

**Severity**: warning
**Message**: `Action 'X' is declared but never referenced in any transition`

**Cause**: `X` appears in the `## actions` table but no transition in the transitions table names it.

**Fix**: Reference `X` in a transition's Action column, or remove it from the actions table.

---

### `ORPHAN_EFFECT`

**Severity**: warning
**Message**: `Effect 'X' is declared but never referenced by any action`

**Cause**: `X` appears in the `## effects` table but no action's signature includes `Effect<X>`.

**Fix**: Add `Effect<X>` to the relevant action's signature, or remove `X` from the effects table.

---

### `UNDECLARED_EFFECT`

**Severity**: warning
**Message**: `Action 'X' references effect 'Y' which is not declared in ## effects`

**Cause**: An action's signature contains `Effect<Y>` but `Y` is not listed in the `## effects` section. Only raised when the `## effects` section is explicitly present.

**Fix**: Add `Y` to the `## effects` section with its input and output types, or correct the typo in the action signature.

---

## Completeness

### `INCOMPLETE_EVENT_HANDLING`

**Severity**: error
**Message**: `State 'X' does not handle event 'Y'`

**Cause**: Event `Y` is declared in `## events` but state `X` has no transition for it and does not have `ignore: Y` in its state definition.

**Fix**: Add a transition `X + Y -> <target>` to the transitions table, or add `- ignore: Y` to state `X`'s definition if the event should be silently discarded in that state.

```markdown
## state active [initial]
- ignore: CANCEL   ← silently discard CANCEL while active

## transitions

| Source | Event  | Target |
|--------|--------|--------|
| active | SUBMIT | done   |
# Without the ignore above, CANCEL would trigger INCOMPLETE_EVENT_HANDLING
```

---

## Determinism

### `NON_DETERMINISTIC`

**Severity**: error
**Message**: `State 'X' has multiple unguarded transitions for event 'Y'`

**Cause**: Two or more transitions share the same (source state, event) pair and neither has a guard. The runtime cannot decide which one to take.

**Fix**: Add guards to all transitions for this (state, event) pair so that exactly one can fire at a time.

```markdown
## transitions

| Source | Event  | Guard    | Target  |
|--------|--------|----------|---------|
| idle   | START  | isReady  | active  |
| idle   | START  | !isReady | waiting |
```

---

### `GUARD_EXHAUSTIVENESS`

**Severity**: warning
**Message**: `State 'X' transitions for event 'Y' may not be exhaustive: guard1, guard2`

**Cause**: Multiple guarded transitions exist for the same (state, event) but the verifier cannot prove the guards cover all possible context values. This is a warning, not an error — the machine is syntactically valid, but there may be runtime states where no guard fires.

**Fix**: Ensure the guards are exhaustive. The simplest pattern is to pair a guard with its negation (`g` and `!g`), or use a catch-all transition with no guard as the last entry.

---

## Properties

These errors are only raised when a `## properties` section is present. They represent violations of developer-specified correctness contracts checked by bounded model checking.

### `PROPERTY_REACHABILITY_FAIL`

**Severity**: error
**Message**: `Property 'reachable: Y from X' violated — no path exists from 'X' to 'Y'`

**Cause**: A `reachable: Y from: X` property asserts that `Y` can be reached from `X`, but the BFS traversal found no such path.

**Fix**: Add or correct transitions so that `Y` is reachable from `X`.

---

### `PROPERTY_EXCLUSION_FAIL`

**Severity**: error
**Message**: `Property 'unreachable: Y from X' violated — path exists: X → ... → Y`

**Cause**: A `unreachable: Y from: X` property asserts that `Y` cannot be reached from `X`, but a path was found. If the path involves guards, a note is appended indicating that guards may prevent it at runtime.

**Fix**: Remove the transitions forming the path, or remove the property if the path is intentional.

---

### `PROPERTY_PATH_FAIL`

**Severity**: error
**Message**: `Property 'passes_through: Z for X -> Y' violated — path bypassing 'Z': X → ... → Y`

**Cause**: A `passes_through: Z for: X to: Y` property asserts that all paths from `X` to `Y` go through `Z`, but a path was found that bypasses `Z`.

**Fix**: Remove the bypass transitions, or split the state graph so that `Z` is mandatory on the `X → Y` path.

---

### `PROPERTY_LIVENESS_FAIL`

**Severity**: error
**Message**: `Property 'live' violated — state 'X' cannot reach any final state`

**Cause**: A `live` property asserts that every reachable state can eventually reach a final state. State `X` is reachable but no final state is reachable from it.

**Fix**: Add transitions from `X` that lead toward a final state, or mark `X` as `[final]`.

---

### `PROPERTY_RESPONSE_FAIL`

**Severity**: error
**Message**: `Property 'responds: Y from X within N' violated — 'Y' not reachable within N transitions`

**Cause**: A `responds: Y from: X within: N` property asserts bounded responsiveness — `Y` must be reachable from `X` in at most `N` transitions. The BFS depth-limited search did not find `Y` within the bound.

**Fix**: Shorten the path from `X` to `Y`, or increase the `within:` bound.

---

### `PROPERTY_INVARIANT_ADVISORY`

**Severity**: warning
**Message**: `Invariant is syntactically valid but cannot be fully verified at topology level`

**Cause**: An `invariant:` property expression is structurally valid (references only declared context fields) but cannot be proved or disproved by topology-level analysis alone — it requires knowing what values actions write into context.

**Effect**: This is always emitted for valid invariants. It is advisory, not an indication of a problem.

---

### `PROPERTY_INVARIANT_INVALID`

**Severity**: error
**Message**: `Invariant references undeclared context field 'X'`

**Cause**: An `invariant:` expression uses `ctx.X` but `X` is not declared in the `## context` block.

**Fix**: Add `X` to the context block, or correct the field name in the invariant expression.

---

### `PROPERTY_AMBIGUOUS_STATE`

**Severity**: error
**Message**: `State name 'X' is ambiguous — matches: A.X, B.X`

**Cause**: A property references a state by simple name (e.g. `idle`) but that name exists in multiple nested contexts (e.g. `payment.idle` and `auth.idle`).

**Fix**: Use the full dot-notation path to disambiguate (e.g. `payment.idle`).

---

### `PROPERTY_INVALID_STATE`

**Severity**: error
**Message**: `State 'X' does not exist in this machine`

**Cause**: A property references a state name that does not exist.

**Fix**: Check the state name spelling. Available states are listed in the error message.

---

## Multi-machine

These codes are only raised when verifying a file containing multiple machines (separated by `---`).

### `CIRCULAR_INVOCATION`

**Severity**: error
**Message**: `Circular invocation detected: A -> B -> A`

**Cause**: Machine A invokes B, and B (directly or transitively) invokes A. Circular invocations would cause infinite recursion at runtime.

**Fix**: Break the cycle. If A and B need to coordinate, use events on a shared event bus rather than direct invocation.

---

### `UNKNOWN_MACHINE`

**Severity**: error
**Message**: `Machine 'Parent' state 'X': invokes unknown machine 'Child'`

**Cause**: A state has `- invoke: Child` but no machine named `Child` is defined in the same file.

**Fix**: Define a machine named `Child` in the same `.orca.md` file, separated from the parent machine by `---`.

---

### `CHILD_NO_FINAL_STATE`

**Severity**: error
**Message**: `Machine 'Parent' state 'X': invoked machine 'Child' has no reachable final state`

**Cause**: The invoked machine `Child` has no `[final]` state reachable from its initial state. The parent's `on_done` transition would never fire.

**Fix**: Add at least one `[final]` state to `Child` and ensure it is reachable.

---

### `UNKNOWN_ON_DONE_EVENT`

**Severity**: error
**Message**: `Machine 'Parent' state 'X': on_done references event 'E' which is not declared`

**Cause**: A state's `- on_done: E` names an event that is not listed in the parent machine's `## events` section.

**Fix**: Add `E` to the parent machine's events list.

---

### `UNKNOWN_ON_ERROR_EVENT`

**Severity**: error
**Message**: `Machine 'Parent' state 'X': on_error references event 'E' which is not declared`

**Cause**: Same as `UNKNOWN_ON_DONE_EVENT` but for the error path.

**Fix**: Add `E` to the parent machine's events list.

---

### `MISSING_ON_ERROR`

**Severity**: warning
**Message**: `Machine 'Parent' state 'X': invoke has no on_error handler — child errors will cause deadlock`

**Cause**: A state invokes a child machine but has no `- on_error:` clause. If the child machine fails, the parent will have no transition to fire and will deadlock.

**Fix**: Add `- on_error: ERROR_EVENT` to the invoking state and handle `ERROR_EVENT` in the parent's transitions table.

---

### `INVALID_INPUT_MAPPING`

**Severity**: error
**Message**: `Machine 'Parent' state 'X': input mapping references 'field' which does not exist in context`

**Cause**: A state's `invoke:` block includes an input mapping like `childField: ctx.parentField`, but `parentField` is not declared in the parent machine's context.

**Fix**: Add `parentField` to the parent machine's `## context` block, or correct the field name in the mapping.

---

### `STATE_LIMIT_EXCEEDED`

**Severity**: error
**Message**: `Combined state count (N) exceeds limit of 64`

**Cause**: The total number of states across all machines in the file exceeds the verifier's limit of 64. This limit exists to keep bounded model checking tractable.

**Fix**: Split the file into multiple `.orca.md` files, or reduce the state count by consolidating related states.

---

## Size

### `MACHINE_TOO_LARGE`

**Severity**: error
**Message**: `Machine has N states (limit: 32). Decompose into hierarchical states or separate machines communicating via events.`

**Cause**: A single machine exceeds the per-machine state limit (32 leaf states). Large machines are hard to verify and tend to indicate a design that should be decomposed.

**Fix**: Break the machine into smaller machines using `invoke:` for coordination, or collapse related states using hierarchical (nested) states.

---

## Severity Guide

| Severity | Meaning | Blocks `verify`? |
|----------|---------|-----------------|
| `error` | Machine is structurally incorrect or violates a property. The machine may not behave as intended. | Yes — exits with code 1 |
| `warning` | Potential issue but the machine is still valid. Common causes: unused declarations, non-exhaustive guards, advisory invariants. | No — exits with code 0 |
