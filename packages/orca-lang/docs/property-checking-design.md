# Property Specification & Bounded Model Checking — Design

## 1. Motivation

The existing Orca verifier catches structural defects (unreachable states, deadlocks, incomplete event handling, non-deterministic guards). These are universal — every well-formed machine should pass.

**Property checking** lets authors (human or LLM) declare *domain-specific* correctness claims about their machine's behavior. Example: "every path from `idle` to `settled` passes through `authorized`." The verifier then proves or disproves each claim using bounded model checking on the finite state graph.

This completes Phase 3 of the Orca roadmap.

---

## 2. Property Language

### 2.1 Syntax Overview

Properties live in a top-level `properties { }` block, alongside `context`, `events`, `states`, etc.:

```orca
machine PaymentProcessor

context { ... }
events { ... }
states { ... }
transitions { ... }
guards { ... }
actions { ... }

properties {
  # Reachability: target can be reached from source
  reachable: authorized from idle

  # Exclusion: target can NEVER be reached from source
  unreachable: settled from cancelled

  # Path ordering: every path from A to B passes through C
  passes_through: authorized for idle -> settled

  # Liveness: from every reachable state, a final state is reachable
  live

  # Bounded response: B reachable from A within N transitions
  responds: settled from idle within 10

  # Context invariant (advisory — requires runtime verification for full proof)
  invariant: ctx.retry_count <= 3
  invariant: ctx.retry_count < 3 in validating
}
```

### 2.2 Property Types

| Property | Syntax | Semantics | Checking Method |
|----------|--------|-----------|-----------------|
| **Reachability** | `reachable: B from A` | ∃ path from A to B | BFS from A |
| **Exclusion** | `unreachable: B from A` | ¬∃ path from A to B | BFS from A, check B not visited |
| **Pass-through** | `passes_through: C for A -> B` | Every A→B path visits C | Remove C, check B unreachable from A |
| **Liveness** | `live` | Every reachable non-final state can reach a final state | BFS from each reachable state |
| **Bounded response** | `responds: B from A within N` | B reachable from A in ≤ N transitions | Depth-bounded BFS |
| **Invariant** | `invariant: <expr> [in <state>]` | Context predicate holds (globally or in a state) | Guard-path analysis (advisory in v1) |

### 2.3 Formal Semantics

**State graph.** Let G = (S, T) where S = set of flattened states (dot-notation), T = set of transitions. For property checking, guards are **ignored** (overapproximation) — all transitions are considered possible. This is sound for reachability (if unreachable ignoring guards, definitely unreachable) and safe for exclusion (violation means a path *structurally* exists, though guards may prevent it).

**Reachable(B, A).** B ∈ BFS(G, A). True iff there exists a sequence of transitions from A to B.

**Unreachable(B, A).** B ∉ BFS(G, A). The negation of reachability.

**PassesThrough(C, A, B).** Let G' = G with state C and all its transitions removed. B ∉ BFS(G', A). Equivalently, C is a *cut vertex* on all A→B paths.

**Live.** ∀ s ∈ Reachable(initial): s is final ∨ ∃ f ∈ FinalStates: f ∈ BFS(G, s).

**Responds(B, A, N).** B ∈ BFS(G, A, depth ≤ N). Bounded-depth search.

**Invariant(expr, state?).** Advisory: validates that `expr` references declared context fields and is a valid guard expression. Full proof requires runtime trace simulation (future phase). In v1, checks that guard conditions on transitions *entering* the target state are *consistent with* the invariant expression (warns if potentially violated).

### 2.4 Guard Handling

All topology-level properties (reachable, unreachable, passes_through, live, responds) treat the state graph as **guard-agnostic**: every transition is possible regardless of guard conditions. This is an overapproximation that provides sound guarantees:

| Property | Overapproximation effect | Sound? |
|----------|-------------------------|--------|
| `reachable` | May report reachable when guards prevent it | Yes — if unreachable ignoring guards, definitely unreachable |
| `unreachable` | May report violation when guards prevent the path | Conservative — false positives, no false negatives |
| `passes_through` | May miss that guards force a detour | Conservative — false negatives possible |
| `live` | May report live when guards create livelock | Conservative — false positives possible |
| `responds` | May report reachable when guards prevent it | Same as `reachable` |

When a property violation is detected despite guards potentially preventing it, the error message notes: *"This check ignores guard conditions. The path may be prevented at runtime by guards."*

### 2.5 State Name Resolution

Properties reference states by name. The checker resolves names as follows:

1. **Exact match** against flattened state names (e.g., `processing.payment_flow.charging`)
2. **Simple name match** against the `simpleName` field (e.g., `charging` resolves to `processing.payment_flow.charging`)
3. **Ambiguity error** if a simple name matches multiple states
4. **Unknown state error** if no match found

This lets users write `reachable: settled from idle` without dot-notation for simple machines, while supporting `reachable: payment_flow.paid from processing` for hierarchical/parallel machines.

### 2.6 Machine Size Limits & Compositional Verification

**Design principle:** If a machine can't be verified in bounded time, it can't be understood. Decompose instead of scaling.

State machines that are too large to verify quickly are also too large for humans (or LLMs) to reason about correctly. Verification time is a *proxy* for cognitive complexity. Rather than optimizing the checker to handle arbitrarily large machines, Orca enforces a size limit and encourages decomposition.

#### Size Limit

A configurable `max_states` limit (default: **64 flattened states**) is checked during `analyzeMachine()`, before any property checking runs. If exceeded:

```
ERROR [MACHINE_TOO_LARGE]: Machine has 83 flattened states (limit: 64).
  Suggestion: Decompose into hierarchical states or separate machines
  communicating via events.
```

The limit is generous — the payment processor has 7 states, the text adventure has 8, and even complex enterprise workflows rarely exceed 30. At 64 states, all property checks complete in < 100ms.

The limit can be overridden via a machine-level annotation (future) or CLI flag for exceptional cases:

```bash
orca verify --max-states 128 large-machine.orca
```

#### Compositional Approach

When a system outgrows a single machine, decomposition uses mechanisms Orca already supports:

| Mechanism | How it helps | Verification |
|-----------|-------------|--------------|
| **Hierarchical states** | A compound state encapsulates a sub-machine | Parent + children verified together (within limit) |
| **Parallel regions** | Independent sub-machines running concurrently | Each region verified independently (no cross-product) |
| **Multiple machines** | Separate `.orca` files communicating via events | Each machine verified independently; interface checked at event contract level |

The key architectural invariant: **verification is always local**. A single machine (including its hierarchy and regions) must fit within the size limit. Cross-machine composition is verified at the *interface level* — matching event vocabularies, not exploring the combined state space.

This mirrors how real distributed systems are designed: each service has a bounded state space, and correctness at the boundary is enforced by contracts.

#### Complexity Budget

At the 64-state limit, worst-case property checking times:

| Property | Complexity | Time at 64 states |
|----------|-----------|-------------------|
| `reachable` / `unreachable` | O(S + T) | < 1ms |
| `passes_through` | O(S + T) | < 1ms |
| `live` | O(S × (S + T)) | < 5ms |
| `responds` | O(min(N, S) + T) | < 1ms |
| All properties combined | — | < 10ms |

The size limit guarantees that verification is always interactive-speed, even on modest hardware.

---

## 3. AST Types

### 3.1 New Types

```typescript
// Property kind discriminator
export type PropertyKind =
  | 'reachable'
  | 'unreachable'
  | 'passes_through'
  | 'live'
  | 'responds'
  | 'invariant';

// Reachability / exclusion
export interface ReachabilityProperty {
  kind: 'reachable' | 'unreachable';
  from: string;   // source state name
  to: string;     // target state name
}

// Path constraint
export interface PassesThroughProperty {
  kind: 'passes_through';
  from: string;     // path start
  to: string;       // path end
  through: string;  // required intermediate state
}

// Global liveness
export interface LiveProperty {
  kind: 'live';
}

// Bounded response
export interface RespondsProperty {
  kind: 'responds';
  from: string;
  to: string;
  within: number;  // max transition count
}

// Context invariant (advisory in v1)
export interface InvariantProperty {
  kind: 'invariant';
  expression: GuardExpression;
  inState?: string;   // optional: specific state; omitted = global
}

// Union type
export type Property =
  | ReachabilityProperty
  | PassesThroughProperty
  | LiveProperty
  | RespondsProperty
  | InvariantProperty;
```

### 3.2 MachineDef Extension

```typescript
export interface MachineDef {
  name: string;
  context: ContextField[];
  events: EventDef[];
  states: StateDef[];
  transitions: Transition[];
  guards: GuardDef[];
  actions: ActionSignature[];
  properties?: Property[];   // <-- NEW
}
```

---

## 4. Parser Changes

### 4.1 New Token

Add `PROPERTIES` to the `TokenType` union and `properties` keyword mapping in the lexer.

The keywords `from`, `for`, `within`, `in`, `passes` are **context-sensitive** — they are only recognized as keywords inside the `parseProperties()` method. The parser matches them as `IDENT` tokens with specific string values. This avoids polluting the global keyword namespace.

### 4.2 Grammar

```
properties_block  = "properties" "{" property* "}"

property = reachability_prop
         | passes_through_prop
         | live_prop
         | responds_prop
         | invariant_prop

reachability_prop    = ("reachable" | "unreachable") ":" IDENT "from" IDENT
passes_through_prop  = "passes_through" ":" IDENT "for" IDENT "->" IDENT
live_prop            = "live"
responds_prop        = "responds" ":" IDENT "from" IDENT "within" NUMBER
invariant_prop       = "invariant" ":" guard_expression ["in" IDENT]
```

The `guard_expression` inside `invariant` reuses the existing guard expression parser (same syntax as guard definitions: `ctx.field op value`, boolean connectives, nullcheck).

### 4.3 parseProperties() Method

```
parseProperties():
  expect PROPERTIES token
  expect LBRACE
  while not RBRACE:
    keyword = expect IDENT
    switch keyword.value:
      "reachable":      parse reachability property (kind: 'reachable')
      "unreachable":    parse reachability property (kind: 'unreachable')
      "passes_through": parse passes-through property
      "live":           push LiveProperty
      "responds":       parse responds property
      "invariant":      parse invariant property
  expect RBRACE
```

---

## 5. Model Checker Implementation

### 5.1 New File: `src/verifier/properties.ts`

The model checker operates on the `MachineAnalysis` object produced by `analyzeMachine()` — the same data structure used by the other verifiers.

### 5.2 Core Algorithm: Graph Traversal

```typescript
/**
 * BFS from a source state, returning the set of reachable states
 * and the path tree (for counterexample extraction).
 */
function bfs(
  stateMap: Map<string, StateInfo>,
  source: string,
  options?: {
    excludeState?: string;   // remove this state from graph
    maxDepth?: number;       // depth bound (undefined = unbounded)
  }
): { reachable: Set<string>; parent: Map<string, { state: string; event: string }> }
```

The `parent` map enables counterexample trace reconstruction: walk backwards from target to source.

### 5.3 Property Checkers

Each property type gets a dedicated checker function:

```typescript
function checkReachable(prop: ReachabilityProperty, analysis: MachineAnalysis): VerificationError[]
function checkUnreachable(prop: ReachabilityProperty, analysis: MachineAnalysis): VerificationError[]
function checkPassesThrough(prop: PassesThroughProperty, analysis: MachineAnalysis): VerificationError[]
function checkLive(analysis: MachineAnalysis): VerificationError[]
function checkResponds(prop: RespondsProperty, analysis: MachineAnalysis): VerificationError[]
function checkInvariant(prop: InvariantProperty, machine: MachineDef, analysis: MachineAnalysis): VerificationError[]
```

### 5.4 Entry Point

```typescript
export function checkProperties(machine: MachineDef): VerificationResult {
  if (!machine.properties || machine.properties.length === 0) {
    return { valid: true, errors: [] };
  }

  const analysis = analyzeMachine(machine);
  const errors: VerificationError[] = [];

  // Resolve state names first (fail fast on invalid references)
  // Then check each property

  for (const prop of machine.properties) {
    switch (prop.kind) {
      case 'reachable':     errors.push(...checkReachable(prop, analysis)); break;
      case 'unreachable':   errors.push(...checkUnreachable(prop, analysis)); break;
      case 'passes_through': errors.push(...checkPassesThrough(prop, analysis)); break;
      case 'live':          errors.push(...checkLive(analysis)); break;
      case 'responds':      errors.push(...checkResponds(prop, analysis)); break;
      case 'invariant':     errors.push(...checkInvariant(prop, machine, analysis)); break;
    }
  }

  return {
    valid: errors.filter(e => e.severity === 'error').length === 0,
    errors
  };
}
```

### 5.5 Complexity Analysis

For a machine with S states and T transitions:

| Property | Time Complexity | Practical Cost |
|----------|----------------|----------------|
| `reachable` | O(S + T) | < 1ms |
| `unreachable` | O(S + T) | < 1ms |
| `passes_through` | O(S + T) | < 1ms |
| `live` | O(S × (S + T)) | < 10ms for typical machines |
| `responds` | O(min(N, S) + T) | < 1ms |
| `invariant` | O(paths × guards) | Variable, bounded by S × T |

All properties are decidable and terminate in polynomial time. For practical Orca machines (5-50 states), total property checking time is < 100ms.

---

## 6. Error Codes & Messages

### 6.1 Error Codes

| Code | Severity | Property | Description |
|------|----------|----------|-------------|
| `PROPERTY_REACHABILITY_FAIL` | error | reachable | Target not reachable from source |
| `PROPERTY_EXCLUSION_FAIL` | error | unreachable | Target IS reachable from source |
| `PROPERTY_PATH_FAIL` | error | passes_through | Path exists that bypasses intermediate |
| `PROPERTY_LIVENESS_FAIL` | error | live | Reachable state cannot reach any final state |
| `PROPERTY_RESPONSE_FAIL` | error | responds | Target not reachable within bound |
| `PROPERTY_INVARIANT_WARN` | warning | invariant | Cannot prove invariant at topology level |
| `PROPERTY_INVALID_STATE` | error | any | Property references non-existent state |
| `PROPERTY_AMBIGUOUS_STATE` | error | any | Simple name matches multiple states |
| `MACHINE_TOO_LARGE` | error | pre-check | Machine exceeds max_states limit (default 64) |

### 6.2 Counterexample Traces

Violation messages include counterexample paths when available:

```
Property 'unreachable: settled from declined' violated.
Path: declined -> [retry_requested] -> validating -> [payment_authorized] -> authorizing -> [payment_authorized] -> authorized -> [settlement_confirmed] -> settled
Note: This check ignores guard conditions. The path may be prevented at runtime by guards.
```

```
Property 'passes_through: authorized for idle -> settled' violated.
Counterexample path avoiding 'authorized': idle -> [submit_payment] -> validating -> ...
```

### 6.3 Suggestions (for LLM refinement)

Each error includes a `suggestion` field that an LLM can use to fix the machine:

```typescript
{
  code: 'PROPERTY_EXCLUSION_FAIL',
  message: "Property 'unreachable: settled from declined' violated.",
  suggestion: "Add a guard condition to prevent transition from declined to validating, or remove the property if the path is intentional."
}
```

---

## 7. CLI Integration

### 7.1 Verify Command

Properties are checked as part of the standard `verify` pipeline:

```bash
orca verify payment-processor.orca
```

Output:
```
Structural verification: PASS
Completeness verification: PASS
Determinism verification: PASS
Property verification: 3 properties checked, all passed
```

Or on failure:
```
Structural verification: PASS
Completeness verification: PASS
Determinism verification: PASS
Property verification: FAIL (1 of 3 properties)
  ERROR: Property 'unreachable: settled from cancelled' violated.
         Path: cancelled -> ... -> settled
```

### 7.2 JSON Output

```bash
orca verify --json payment-processor.orca
```

Includes a `properties` section in the JSON result:

```json
{
  "valid": false,
  "structural": { "valid": true, "errors": [] },
  "completeness": { "valid": true, "errors": [] },
  "determinism": { "valid": true, "errors": [] },
  "properties": {
    "valid": false,
    "checked": 3,
    "passed": 2,
    "errors": [
      {
        "code": "PROPERTY_EXCLUSION_FAIL",
        "message": "Property 'unreachable: settled from cancelled' violated.",
        "severity": "error",
        "location": { "state": "cancelled" },
        "counterexample": ["cancelled", "retry_requested", "validating", "..."],
        "suggestion": "..."
      }
    ]
  }
}
```

### 7.3 Skill Integration

The `/verify-orca` skill already returns JSON — property results are included automatically when a `properties` block exists.

---

## 8. Example

### 8.1 Payment Processor with Properties

```orca
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

# ... states, transitions, guards, actions as before ...

properties {
  # Settlement requires authorization
  passes_through: authorized for idle -> settled

  # Cancelled payments never settle
  unreachable: settled from failed

  # Authorization is reachable
  reachable: authorized from idle

  # Machine is live — no state traps
  live

  # Settlement reachable within 5 transitions from idle
  responds: settled from idle within 5

  # Retry count stays bounded (advisory — topology check only)
  invariant: ctx.retry_count <= 3
}
```

---

## 9. Implementation Plan

### Phase A: AST & Parser
1. Add `Property` types to `ast.ts`
2. Add `PROPERTIES` token to lexer
3. Add `properties?: Property[]` to `MachineDef`
4. Implement `parseProperties()` in parser
5. Parser tests

### Phase B: Model Checker
1. Create `src/verifier/properties.ts`
2. Add `MACHINE_TOO_LARGE` size check in `analyzeMachine()` (default 64 flattened states)
3. Implement `bfs()` with exclude and depth-bound options
4. Implement counterexample trace extraction
5. Implement each property checker
6. Implement state name resolution (simple → flattened)
7. Model checker tests

### Phase C: CLI Integration
1. Add `checkProperties()` call to verify pipeline in `index.ts`
2. Update JSON output format
3. Integration tests with example files

### Phase D: Polish
1. Create example `.orca` file with properties
2. Update CLAUDE.md to mark Phase 3 complete
3. Update orca-proposal.md if needed

**Estimated scope:** ~400 lines of new code, ~300 lines of tests.

---

## 10. Future Extensions (Not in v1)

1. **Guard-aware model checking** — Use guard satisfiability analysis to prune impossible transitions. Improves precision of `unreachable` and `passes_through`.

2. **Trace simulation** — Execute actions against synthetic contexts to verify `invariant` properties concretely. Requires action implementations.

3. **CTL/LTL syntax** — For power users who want full temporal logic expressiveness (AG, EF, AF, EU, etc.).

4. **Fairness constraints** — "Under fair scheduling, property P holds." Relevant for parallel regions.

5. **Compositional checking** — Verify properties across multiple interacting machines.

6. **Custom property functions** — User-defined checking logic in TypeScript/Python.
