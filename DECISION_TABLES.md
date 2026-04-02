# Decision Tables in Orca

Decision tables are a first-class document type in Orca, living alongside state machines in the same `.orca.md` files. They handle complex conditional logic — the cases where a state machine would otherwise grow a sprawling tangle of guards.

---

## The problem they solve

A state machine's job is to describe *when* things happen: which events trigger which transitions, in which order, under what topology. It is not a great tool for describing *what* should happen when many conditions interact.

Suppose a payment router needs to select a gateway based on `amount_tier`, `customer_type`, and `has_fraud_flag`. Encoding this in guards looks like:

```
| routing | route | is_high_fraud             | flagged   |                 |
| routing | route | is_high_vip               | approved  |                 |
| routing | route | is_high_other             | review    |                 |
| routing | route | is_medium                 | stripe    |                 |
...
```

Each guard needs a name, a definition, and the pairs must be mutually exclusive or the verifier complains. As conditions multiply, the number of guards explodes combinatorially — and the logic is scattered across the transitions table, the guards table, and the action implementations.

A decision table encodes the same logic as a single, readable structure:

```markdown
| amount_tier | customer_type | has_fraud_flag | → gateway     | → requires_approval | → risk_level |
|-------------|---------------|----------------|---------------|---------------------|--------------|
| high        | -             | true           | manual_review | true                | high         |
| high        | vip           | false          | stripe        | false               | low          |
| high        | returning     | false          | adyen         | false               | medium       |
| high        | new           | false          | manual_review | true                | medium       |
| medium      | -             | -              | stripe        | false               | low          |
| low         | -             | -              | stripe        | false               | low          |
```

The state machine stays clean (one transition, one action), and the routing logic lives where it belongs.

---

## Format

Decision tables use `# decision_table Name` as a top-level heading — a peer to `# machine Name`. They live in `.orca.md` files separated by `---`, the same multi-document separator used for multi-machine files.

```markdown
# decision_table SimpleDiscount

## conditions

| Name       | Type | Values               |
|------------|------|----------------------|
| tier       | enum | gold, silver, bronze |
| is_holiday | bool |                      |

## actions

| Name             | Type | Values          |
|------------------|------|-----------------|
| discount_percent | enum | none, five, ten |

## rules

| tier   | is_holiday | → discount_percent |
|--------|------------|--------------------|
| gold   | true       | ten                |
| gold   | false      | ten                |
| silver | true       | five               |
| silver | false      | none               |
| bronze | -          | none               |
```

### Sections

**`## conditions`** — the input columns. Each row declares a named field, its type, and (for `enum`) its possible values. Supported types: `enum`, `bool`, `string`, `int_range`.

**`## actions`** — the output columns. Each row names a field that the table sets when a rule matches.

**`## rules`** — the table body. Condition columns are referenced by name; action columns carry a `→` prefix. Rules are evaluated top-to-bottom; the first match wins.

### Cell syntax

| Cell | Meaning |
|------|---------|
| `value` | Exact match |
| `-` | Any value (wildcard / don't care) |
| `!value` | Any value except `value` |
| `a, b` | Match `a` or `b` |
| *(empty)* | Same as `-` |

---

## Co-location with machines

A decision table co-located in the same file as a machine is a declaration of intent: this table is how this machine's action computes its output. The machine handles control flow; the table handles the conditional logic inside one of its actions.

```markdown
# machine PaymentProcessor

## context

| Field         | Type | Default |
|---------------|------|---------|
| amount_tier   | enum | low, medium, high |
| customer_type | enum | new, returning, vip |
| has_fraud_flag | bool | false |
| gateway       | enum | stripe, adyen, manual_review |
| requires_approval | bool | false |
| risk_level    | enum | low, medium, high |

## state idle [initial]
## state routing
## state processing
## state approved [final]
## state declined [final]

## transitions

| Source     | Event            | Guard | Target     | Action                  |
|------------|------------------|-------|------------|-------------------------|
| idle       | submit_payment   |       | routing    | calculate_amount_tier   |
| routing    | route_decision   |       | processing | apply_routing_decision  |
| processing | payment_approved |       | approved   | mark_approved           |
| processing | payment_declined |       | declined   | mark_declined           |

## actions

| Name                   | Signature           |
|------------------------|---------------------|
| calculate_amount_tier  | `(ctx) -> Context`  |
| apply_routing_decision | `(ctx) -> Context`  |
| mark_approved          | `(ctx) -> Context`  |
| mark_declined          | `(ctx) -> Context`  |

---

# decision_table PaymentRouting

## conditions

| Name           | Type | Values               |
|----------------|------|----------------------|
| amount_tier    | enum | low, medium, high    |
| customer_type  | enum | new, returning, vip  |
| has_fraud_flag | bool |                      |

## actions

| Name              | Type | Values                        |
|-------------------|------|-------------------------------|
| gateway           | enum | stripe, adyen, manual_review  |
| requires_approval | bool |                               |
| risk_level        | enum | low, medium, high             |

## rules

| amount_tier | customer_type | has_fraud_flag | → gateway     | → requires_approval | → risk_level |
|-------------|---------------|----------------|---------------|---------------------|--------------|
| high        | -             | true           | manual_review | true                | high         |
| high        | vip           | false          | stripe        | false               | low          |
| high        | returning     | false          | adyen         | false               | medium       |
| high        | new           | false          | manual_review | true                | medium       |
| medium      | -             | -              | stripe        | false               | low          |
| low         | -             | -              | stripe        | false               | low          |
```

The `apply_routing_decision` action calls `evaluatePaymentRouting(ctx)` at runtime and merges the result into the context. The machine does not need to know the routing rules; the decision table does not need to know about states or events.

---

## Verification

Orca verifies decision tables with the same pipeline used for state machines: parse → verify → compile. Running `verify` on a file checks both.

### Checks

**Completeness** (`DT_INCOMPLETE`) — every possible combination of condition values must have at least one matching rule. Missing combinations are reported with the specific uncovered input vector.

**Consistency** (`DT_INCONSISTENT`) — two rules that match the same input must not produce different outputs. With the default first-match policy this is a warning (the earlier rule wins); with `all-match` it is an error.

**Redundancy** (`DT_REDUNDANT`) — a rule that is fully shadowed by a preceding rule is flagged as a warning.

**Structural** — unknown condition/action values, missing columns, empty rules tables, duplicate rules.

### Co-location checks

When a decision table shares a file with exactly one machine and its condition/action fields are a subset of the machine's context, two additional checks run:

**Coverage gap** (`DT_COVERAGE_GAP`) — the DT must handle every input combination the machine context can produce. This is stricter than basic completeness: it uses the machine's declared enum values as the authoritative domain, not just the values mentioned in the DT.

**Dead guards** (`DT_GUARD_DEAD`) — a machine guard that tests a DT output field against a value the DT never produces can never be true. Reported as a warning.

**DT-constrained reachability** (`DT_UNREACHABLE_STATE`) — if all paths to a state are guarded by dead guards, the state cannot be entered given the DT's output constraints. The structural verifier still sees the state as reachable (there is a graph path), but the DT makes it semantically unreachable.

**Properties precision** — the property checker (`## properties`) becomes more precise when a co-located DT is present. `reachable`, `unreachable`, `responds`, `live`, and `passes_through` properties all benefit: the BFS prunes transitions whose guards compare a DT output field against a value the DT never produces, giving fewer false negatives and fewer false positives.

---

## Compilation

Once verified, a decision table compiles to an evaluator function. The generated function takes a typed input struct and returns a typed output struct (or `null` if no rule matched).

```bash
# Via CLI
npx tsx src/index.ts compile decision-table typescript examples/payment-with-routing.orca.md

# Via MCP tool
compile_decision_table({ source: "...", target: "typescript" })
```

**TypeScript output:**

```typescript
export interface PaymentRoutingInput {
  amount_tier: 'low' | 'medium' | 'high';
  customer_type: 'new' | 'returning' | 'vip';
  has_fraud_flag: boolean;
}

export interface PaymentRoutingOutput {
  gateway: 'stripe' | 'adyen' | 'manual_review';
  requires_approval: boolean;
  risk_level: 'low' | 'medium' | 'high';
}

export function evaluatePaymentRouting(
  input: PaymentRoutingInput
): PaymentRoutingOutput | null {
  // Rule 1
  if (input.amount_tier === 'high' && input.has_fraud_flag === true) {
    return { gateway: 'manual_review', requires_approval: true, risk_level: 'high' };
  }
  // Rule 2
  if (input.amount_tier === 'high' && input.customer_type === 'vip' && input.has_fraud_flag === false) {
    return { gateway: 'stripe', requires_approval: false, risk_level: 'low' };
  }
  // ...
  return null;
}
```

**Python and Go** outputs follow the same structure in their respective languages.

---

## MCP tools and skills

Decision tables are fully supported via the MCP server and the CLI skills.

| Tool / Skill | What it does |
|---|---|
| `generate_decision_table` / `/orca-generate` | Generate a verified DT from a natural language spec |
| `verify_decision_table` / `/orca-verify` | Parse and verify; returns structured errors |
| `compile_decision_table` / `/orca-compile` | Compile to TypeScript, Python, Go, or JSON evaluator |
| `parse_decision_table` | Parse to AST JSON (conditions, actions, rules) |

Skills that work with combined files (machine + DT in the same source) automatically verify and compile both documents.

---

## Examples

All examples are in `packages/orca-lang/examples/`:

| File | Description |
|------|-------------|
| `simple-discount.orca.md` | Minimal standalone DT — 2 conditions, 1 action, 6 rules |
| `payment-routing.orca.md` | Standalone payment gateway router — 3 conditions, 3 outputs |
| `shipping-rules.orca.md` | Shipping cost calculator — weight and zone conditions |
| `payment-with-routing.orca.md` | Combined: PaymentProcessor machine + PaymentRouting DT |

Working demos with decision tables:

| Package | Description |
|---------|-------------|
| `demo-ts` | Support Ticket Escalation — 8-state workflow + 2 DTs (triaging + routing) |
| `demo-python` | Order Fulfillment — 6-state workflow + DT for shipping/warehouse/fraud routing |
| `demo-go` | Loan Application Processor — 6-state workflow + 2 DTs (risk assessment + disbursement) |

---

## Design rationale

**Why co-location instead of separate files?** An LLM can generate a machine and its decision logic in a single document, and the whole thing is verifiable in one pass. The `---` separator and H1 dispatch already support multiple document types in one file; decision tables plug into the same mechanism.

**Why first-match as the default policy?** It reads like `if/else if/else` — familiar, ordered, and predictable. A catch-all row (`-` in every condition column) placed last makes default behavior explicit without needing to enumerate every combination.

**Why `→` prefix on action columns?** Without it there is no way to distinguish condition columns from output columns by reading the table header. The `→` or `->` prefix is the only visual marker needed; no additional metadata required.

**Why not guards?** Guards are predicates — true or false. Decision tables produce *values*, not truth judgments. They are the right abstraction for routing, classification, configuration lookup, and any logic where the output is multi-dimensional. Guards remain the right abstraction for controlling which transition fires; decision tables are the right abstraction for what an action computes inside a state.
