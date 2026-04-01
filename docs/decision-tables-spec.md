# Add Decision Tables to Orca-Lang

## Overview

Add **Decision Tables** as a new document type within the `.orca.md` format, as a peer to state machines. Decision tables complement state machines by handling complex conditional logic *within* states, where a state machine would otherwise suffer from state explosion or guard spaghetti.

Decision tables are embedded in `.orca.md` files alongside machines, separated by `---` (the same multi-document separator already used for multi-machine files). This means an LLM can generate a complete system design — state machines plus their decision logic — in a single document, and the entire thing is formally verifiable in one pass.

The format uses `# decision_table Name` as an H1 heading, parallel to `# machine Name`. The existing `OrcaFile` container gains a `decisionTables` field alongside `machines`.

## Architecture Principles

Follow these principles from the existing orca-lang architecture:

1. **Same AST pipeline pattern**: Parser → AST → Verifier → Compiler (just like state machines)
2. **Same document conventions**: `# decision_table Name` heading, `## sections` for structure
3. **Embedded, not separate**: Decision tables live in `.orca.md` files alongside machines, separated by `---`. No new file extension.
4. **Same MCP tool pattern**: `parse_decision_table`, `verify_decision_table`, `compile_decision_table`, `generate_decision_table`
5. **Same error infrastructure**: Reuse `VerificationError`, `Severity`, error codes with suggestions
6. **Same skill pattern**: Skills accept `{ source?: string; file?: string }` — no files required
7. **Parser integration**: The existing markdown parser's multi-document splitting logic (splitting on `---`) already produces separate document chunks. Each chunk's H1 heading determines its type: `# machine` → `MachineDef`, `# decision_table` → `DecisionTableDef`. This is the key integration point.

## Format Specification

### Standalone Decision Table

```markdown
# decision_table PaymentRouting

Optional prose description of what this table decides.

## conditions

| Name | Type | Values |
|------|------|--------|
| amount_tier | enum | low, medium, high |
| customer_type | enum | new, returning, vip |
| has_fraud_flag | bool | |
| currency | enum | USD, EUR, GBP |

## actions

| Name | Type | Description |
|------|------|-------------|
| gateway | enum | stripe, adyen, manual_review |
| requires_approval | bool | Whether manual approval is needed |
| risk_level | enum | low, medium, high |

## rules

| # | amount_tier | customer_type | has_fraud_flag | currency | → gateway | → requires_approval | → risk_level |
|---|-------------|---------------|----------------|----------|-----------|---------------------|--------------|
| 1 | high | - | true | - | manual_review | true | high |
| 2 | high | vip | false | - | stripe | false | low |
| 3 | high | - | false | - | adyen | true | medium |
| 4 | medium | new | - | - | stripe | true | medium |
| 5 | medium | - | false | - | stripe | false | low |
| 6 | low | - | false | - | stripe | false | low |
| 7 | - | - | true | - | manual_review | true | high |
```

### Combined Machine + Decision Table

```markdown
# machine PaymentProcessor

## state idle [initial]
> Waiting for payment submission

## state routing
> Determining payment gateway via decision table
- on_entry: route_payment

## state processing
> Payment is being processed
- on_entry: process_payment

## state completed [final]
> Payment completed

## state failed [final]
> Payment failed

## transitions

| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| idle | submit_payment | | routing | initialize |
| routing | routed | | processing | |
| processing | payment_success | | completed | record_success |
| processing | payment_failed | | failed | record_failure |

## actions

| Name | Signature |
|------|-----------|
| initialize | `(ctx, event) -> Context` |
| route_payment | `(ctx) -> Context` |
| process_payment | `(ctx) -> Context + Effect<PaymentCharge>` |
| record_success | `(ctx) -> Context` |
| record_failure | `(ctx) -> Context` |

---

# decision_table PaymentRouting

Used by the route_payment action to select gateway and risk parameters.

## conditions

| Name | Type | Values |
|------|------|--------|
| amount_tier | enum | low, medium, high |
| customer_type | enum | new, returning, vip |
| has_fraud_flag | bool | |

## actions

| Name | Type | Description |
|------|------|-------------|
| gateway | enum | stripe, adyen, manual_review |
| requires_approval | bool | Whether manual approval is needed |
| risk_level | enum | low, medium, high |

## rules

| # | amount_tier | customer_type | has_fraud_flag | → gateway | → requires_approval | → risk_level |
|---|-------------|---------------|----------------|-----------|---------------------|--------------|
| 1 | high | - | true | manual_review | true | high |
| 2 | high | vip | false | stripe | false | low |
| 3 | high | - | false | adyen | true | medium |
| 4 | medium | new | - | stripe | true | medium |
| 5 | medium | - | false | stripe | false | low |
| 6 | low | - | - | stripe | false | low |
| 7 | - | - | true | manual_review | true | high |
```

### Format Rules

- `# decision_table Name` — required H1 heading (peer to `# machine Name`)
- `## conditions` — table defining inputs. Columns: Name, Type (`bool`, `enum`, `int_range`, `string`), Values (comma-separated for enums, `min..max` for ranges; empty for bool since values are implicitly true/false)
- `## actions` — table defining outputs. Columns: Name, Type, Description
- `## rules` — the decision table itself. Column headers are condition names (plain) and action names (prefixed with `→` or `->`)
- `-` in a condition cell means "any" (don't care / wildcard)
- `#` column is optional rule numbering (ignored by parser, useful for humans)
- Rules are evaluated top-to-bottom; first match wins (priority ordering) by default
- Future: `## metadata` section for policy (first-match vs all-match), default rule, etc.

## Phase 1: AST Types & Parser Integration

### AST Types

Create `packages/orca-lang/src/parser/dt-ast.ts`:

```typescript
// Decision Table AST

export type ConditionType = 'bool' | 'enum' | 'int_range' | 'string';

export interface ConditionDef {
  name: string;
  type: ConditionType;
  values: string[];         // enum values, or ['true','false'] for bool
  range?: { min: number; max: number };  // for int_range
}

export type ActionType = 'bool' | 'enum' | 'string';

export interface ActionOutputDef {
  name: string;
  type: ActionType;
  description?: string;
  values?: string[];        // valid values for enum type
}

export type CellValue =
  | { kind: 'any' }                           // "-" wildcard
  | { kind: 'exact'; value: string }          // exact match
  | { kind: 'negated'; value: string }        // "!value"
  | { kind: 'set'; values: string[] };        // "a,b" (match any in set)

export interface Rule {
  number?: number;           // optional rule # from the # column
  conditions: Map<string, CellValue>;   // condition name → cell value
  actions: Map<string, string>;          // action name → output value
}

export interface DecisionTableDef {
  name: string;
  description?: string;
  conditions: ConditionDef[];
  actions: ActionOutputDef[];
  rules: Rule[];
  policy: 'first-match' | 'all-match';  // default: first-match
}
```

Note: Name the action type `ActionOutputDef` (not `ActionDef`) to avoid collision with the existing state machine `ActionSignature` type. These are decision table outputs, not state machine actions.

### Extend OrcaFile

In `packages/orca-lang/src/parser/ast.ts`, extend the existing `OrcaFile` interface:

```typescript
import { DecisionTableDef } from './dt-ast.js';

export interface OrcaFile {
  machines: MachineDef[];
  decisionTables: DecisionTableDef[];  // NEW
}
```

This is the key integration point. Every place that constructs or consumes `OrcaFile` needs to handle the new field. The `decisionTables` array defaults to `[]` for files with no decision tables (backward compatible).

### Parser Integration

The existing `markdown-parser.ts` already splits multi-document files on `---` and dispatches on the H1 heading. The change is:

1. After splitting on `---`, for each chunk:
   - If H1 matches `# machine <Name>` → parse as `MachineDef` (existing path)
   - If H1 matches `# decision_table <Name>` → parse as `DecisionTableDef` (new path)
   - Otherwise → error or skip (depending on lenient/strict mode)

2. Create `packages/orca-lang/src/parser/dt-parser.ts` with a `parseDecisionTable(chunk)` function that handles the DT-specific sections (`## conditions`, `## actions`, `## rules`).

3. The main `parseMarkdown()` function in `markdown-parser.ts` collects results into `OrcaFile.machines` and `OrcaFile.decisionTables` respectively.

**Key implementation detail**: Look at how `markdown-parser.ts` currently handles the `---` splitting and H1 dispatch. The DT parser should plug into the same dispatch point. Don't duplicate the structural markdown parsing — reuse `markdown-it` table/heading extraction and just add a new semantic dispatch path.

### Cell Value Parsing

In the `## rules` table, cell content is micro-parsed:

| Cell Content | Parsed As | Notes |
|---|---|---|
| `-` | `{ kind: 'any' }` | Wildcard |
| `value` | `{ kind: 'exact', value: 'value' }` | Exact match |
| `!value` | `{ kind: 'negated', value: 'value' }` | Negation |
| `a,b,c` | `{ kind: 'set', values: ['a','b','c'] }` | Multi-value (match any) |
| empty cell | `{ kind: 'any' }` | Treat same as `-` |

### Column Detection in Rules Table

The `## rules` table header determines which columns are conditions and which are actions:

- Column `#` → skip (rule numbering)
- Column starting with `→ ` or `-> ` → action column (strip prefix to get action name)
- All other columns → condition columns
- Validate: every condition column name must match a name in `## conditions`
- Validate: every action column name (after prefix stripping) must match a name in `## actions`

### Tests

Create `packages/orca-lang/tests/dt-parser.test.ts`. Test cases:

- Parse minimal decision table (1 condition, 1 action, 1 rule)
- Parse full PaymentRouting example
- Combined machine + decision table file parses into `OrcaFile` with both populated
- Wildcard cells produce `{ kind: 'any' }`
- Negated cells (`!vip`) produce `{ kind: 'negated' }`
- Set cells (`USD,EUR`) produce `{ kind: 'set' }`
- Missing `## conditions` throws parse error
- Missing `## rules` throws parse error
- Unknown column in rules table (not a condition and not prefixed with `→`) produces warning
- Bool conditions auto-populate values `['true', 'false']` when Values column is empty
- Empty decision table (no rules) parses successfully with empty rules array
- Description prose between `# decision_table` and first `##` is captured
- Existing machine-only files still parse correctly (backward compatibility — `decisionTables` is `[]`)
- Multi-machine files still parse correctly with `decisionTables: []`
- File with only decision tables (no machines) parses correctly with `machines: []`

## Phase 2: Verifier

Create `packages/orca-lang/src/verifier/dt-verifier.ts`.

### Verification Checks

**Completeness Check** (`DT_INCOMPLETE`):
- For each possible combination of condition values, check that at least one rule matches.
- For small tables (product of all condition value counts ≤ 4096 combinations), enumerate all combinations and check each against the rules.
- For larger tables, use a symbolic approach: check that wildcard coverage + explicit rules span the space (or emit a warning that full completeness checking was skipped due to size, code `DT_COMPLETENESS_SKIPPED`).
- `-` (any) cells implicitly cover all values for that condition.
- Report missing combinations as errors, including the specific uncovered input vector in the suggestion.

**Consistency Check** (`DT_INCONSISTENT`):
- Find pairs of rules that can match the same input but produce different action values.
- Two rules overlap if, for every condition column, the intersection of their cell values is non-empty.
- If rules overlap and all action columns agree → redundant but consistent (→ redundancy check).
- If rules overlap and any action column disagrees → inconsistent.
- For `first-match` policy (default): inconsistency is a **warning** (higher-priority rule wins, so there's no actual ambiguity, but it may indicate a logic error).
- For `all-match` policy: inconsistency is an **error** (ambiguous result).

**Redundancy Check** (`DT_REDUNDANT`):
- A rule is fully redundant if removing it doesn't change the table's behavior.
- In `first-match`: a rule is redundant if every input it matches is already matched by a higher-priority (earlier) rule with the same action values.
- Severity: warning.

**Structural Checks**:
- `DT_UNKNOWN_CONDITION_VALUE`: Rule cell contains a value not in the condition's declared Values list
- `DT_UNKNOWN_ACTION_VALUE`: Rule action cell contains a value not declared in the action's Values list (for enum actions)
- `DT_MISSING_ACTION_COLUMN`: A declared action has no corresponding `→ name` column in the rules table
- `DT_MISSING_CONDITION_COLUMN`: A declared condition has no corresponding column in the rules table
- `DT_EMPTY_RULES`: Rules table has zero data rows (warning)
- `DT_DUPLICATE_RULE`: Two rules have identical condition patterns (warning)
- `DT_NO_CONDITIONS`: No conditions declared (error)
- `DT_NO_ACTIONS`: No actions declared (error)

### Error Location

Extend the error location to support DT-specific context:

```typescript
// In verifier/types.ts, extend the existing location type:
location?: {
  state?: string;        // existing
  event?: string;        // existing
  transition?: Transition;  // existing
  rule?: number;         // NEW - rule number (1-based)
  condition?: string;    // NEW - condition name
  action?: string;       // NEW - action name  (use 'action' since that field doesn't exist yet)
  decisionTable?: string; // NEW - decision table name
};
```

### Tests

Create `packages/orca-lang/tests/dt-verifier.test.ts`. Test cases:

- Complete table with full coverage passes
- Incomplete table (missing combination) fails with `DT_INCOMPLETE` and suggestion shows the missing vector
- Inconsistent rules (same input, different output, all-match) fails with `DT_INCONSISTENT`
- Inconsistent rules with first-match policy produces warning, not error
- Redundant rule detected with `DT_REDUNDANT`
- Unknown condition value caught with `DT_UNKNOWN_CONDITION_VALUE`
- Unknown action value caught with `DT_UNKNOWN_ACTION_VALUE`
- Bool condition: only `true` rules but missing `false` coverage → incomplete
- Wildcard-heavy table (all `-` except one column) passes completeness
- Empty rules table produces `DT_EMPTY_RULES` warning
- Large table (> 4096 combinations) gets `DT_COMPLETENESS_SKIPPED` warning instead of error
- Combined file: machine verifier still runs on machines, DT verifier runs on decision tables, results are merged

## Phase 3: Compiler

Create `packages/orca-lang/src/compiler/dt-compiler.ts`.

### Compilation Targets

**TypeScript** (`target: 'typescript'`):
Generate a typed evaluator function:

```typescript
// Generated from decision_table PaymentRouting
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

export function evaluatePaymentRouting(input: PaymentRoutingInput): PaymentRoutingOutput | null {
  // Rule 1: amount_tier=high, has_fraud_flag=true
  if (input.amount_tier === 'high' && input.has_fraud_flag === true) {
    return { gateway: 'manual_review', requires_approval: true, risk_level: 'high' };
  }
  // Rule 2: amount_tier=high, customer_type=vip, has_fraud_flag=false
  if (input.amount_tier === 'high' && input.customer_type === 'vip' && input.has_fraud_flag === false) {
    return { gateway: 'stripe', requires_approval: false, risk_level: 'low' };
  }
  // ... remaining rules ...
  return null; // no rule matched
}
```

Key details:
- Wildcard conditions (`-`) generate no clause in the if-statement
- Bool conditions generate `=== true` / `=== false`
- Negated conditions generate `!== value`
- Set conditions generate `(input.x === 'a' || input.x === 'b')`
- Function returns `null` if no rule matches (caller handles default)
- Function name is `evaluate` + PascalCase table name

**JSON** (`target: 'json'`):
Serialize the verified table as a portable JSON structure:

```json
{
  "name": "PaymentRouting",
  "conditions": [
    { "name": "amount_tier", "type": "enum", "values": ["low", "medium", "high"] }
  ],
  "actions": [
    { "name": "gateway", "type": "enum", "values": ["stripe", "adyen", "manual_review"] }
  ],
  "rules": [
    { "conditions": { "amount_tier": "high", "has_fraud_flag": "true" }, "actions": { "gateway": "manual_review", "requires_approval": "true", "risk_level": "high" } }
  ],
  "policy": "first-match"
}
```

Note: `-` (wildcard) conditions are omitted from the JSON rule object (absence = any).

**Mermaid**: Skip for v1. Decision tables don't have a natural diagrammatic representation.

### Tests

Create `packages/orca-lang/tests/dt-compiler.test.ts`. Test cases:

- TypeScript output contains correct interface types
- Generated function returns correct output for known inputs (test at string level)
- Wildcard conditions don't generate if-clauses
- Bool conditions generate `=== true` / `=== false`
- Negated conditions generate `!==`
- Set conditions generate `||` chains
- JSON target produces valid JSON
- JSON omits wildcard conditions from rule objects
- Empty rules table generates function that always returns null
- Combined file: `compile_decision_table` compiles only the DT, not the machine

## Phase 4: MCP Tools & Skills

### New Tools

Add to `packages/orca-lang/src/tools.ts` (the `ORCA_TOOLS` array):

```typescript
{
  name: 'parse_decision_table',
  description: 'Parse decision table from .orca.md source → JSON (conditions, actions, rules). Syntax: # decision_table Name, ## conditions table, ## actions table, ## rules table. Can be standalone or combined with machines in the same file.',
  inputSchema: {
    type: 'object',
    properties: {
      source: { type: 'string', description: 'Raw .orca.md content containing a # decision_table heading.' },
    },
    required: ['source'],
  },
},
{
  name: 'verify_decision_table',
  description: 'Verify decision table: checks completeness (all condition combinations covered), consistency (no contradictory rules), redundancy. Returns structured errors with codes and suggestions.',
  inputSchema: {
    type: 'object',
    properties: {
      source: { type: 'string', description: 'Raw .orca.md content containing a # decision_table heading.' },
    },
    required: ['source'],
  },
},
{
  name: 'compile_decision_table',
  description: 'Compile verified decision table to TypeScript evaluator function or portable JSON. Run verify_decision_table first. target: "typescript" (default) or "json".',
  inputSchema: {
    type: 'object',
    properties: {
      source: { type: 'string', description: 'Raw .orca.md content containing a # decision_table heading.' },
      target: { type: 'string', enum: ['typescript', 'json'], description: 'Compilation target (default: typescript)' },
    },
    required: ['source'],
  },
},
{
  name: 'generate_decision_table',
  description: 'Generate a decision table in .orca.md format from a natural language spec. Always verify_decision_table next. Requires LLM API key.',
  inputSchema: {
    type: 'object',
    properties: {
      spec: { type: 'string', description: 'Natural language description of the decision logic' },
    },
    required: ['spec'],
  },
},
```

### Skills

Add to `packages/orca-lang/src/skills.ts` (or a new `dt-skills.ts` file that's re-exported):

- `parseDTSkill(input: SkillInput)` — parse and return structured JSON (conditions, actions, rules)
- `verifyDTSkill(input: SkillInput)` — parse + verify, return result with status/errors
- `compileDTSkill(input: SkillInput, target: 'typescript' | 'json')` — parse + compile
- `generateDTSkill(spec: string)` — LLM generation with a `.dt.md` syntax reference prompt

For `generateDTSkill`, create a `DT_SYNTAX_REFERENCE` constant (parallel to the existing `ORCA_SYNTAX_REFERENCE` for machines) that goes into the LLM prompt. It should be compact — under 400 tokens — covering the heading structure, table formats, cell value syntax (`-`, `!value`, `a,b`), and the `→` prefix convention for action columns.

### MCP Server

Update `packages/mcp-server/src/server.ts`:

1. Import the new DT skills
2. Add 4 new cases to the `callTool` switch: `parse_decision_table`, `verify_decision_table`, `compile_decision_table`, `generate_decision_table`
3. Update `MCP_INSTRUCTIONS` to include a compact syntax reference for decision tables

### Tests

Extend `packages/mcp-server/src/server.test.ts` (or create `dt-server.test.ts`):

- `parse_decision_table` returns structured result
- `verify_decision_table` returns valid/invalid status
- `compile_decision_table` returns TypeScript output
- Tools work with combined machine + DT source (extracts only the DT)

## Phase 5: Examples

Create example files in `packages/orca-lang/examples/`:

1. **`simple-discount.dt.orca.md`** — minimal standalone DT (2 conditions, 1 action, 4 rules, complete). Good for testing.

2. **`payment-routing.dt.orca.md`** — the PaymentRouting example from this spec (medium complexity, ~7 rules). Standalone.

3. **`payment-with-routing.orca.md`** — combined machine + decision table. A payment processor state machine with an embedded PaymentRouting decision table. Demonstrates the co-location pattern.

4. **`shipping-rules.dt.orca.md`** — shipping cost calculator with enum tiers for weight and zone. Tests broader condition types.

Each example should pass `verify_decision_table` cleanly. The combined example should pass both `verify_machine` and `verify_decision_table`.

**Naming convention**: Standalone decision tables use `.dt.orca.md` (makes it clear what's inside). Combined files keep the regular `.orca.md` extension. The parser doesn't care about the extension — it dispatches on the H1 heading.

## File Organization Summary

New files to create:
```
packages/orca-lang/src/parser/dt-ast.ts          # AST types
packages/orca-lang/src/parser/dt-parser.ts        # Decision table parser
packages/orca-lang/src/verifier/dt-verifier.ts    # Completeness/consistency/redundancy
packages/orca-lang/src/compiler/dt-compiler.ts    # TypeScript + JSON output
packages/orca-lang/tests/dt-parser.test.ts        # Parser tests
packages/orca-lang/tests/dt-verifier.test.ts      # Verifier tests
packages/orca-lang/tests/dt-compiler.test.ts      # Compiler tests
packages/orca-lang/examples/simple-discount.dt.orca.md
packages/orca-lang/examples/payment-routing.dt.orca.md
packages/orca-lang/examples/payment-with-routing.orca.md
packages/orca-lang/examples/shipping-rules.dt.orca.md
```

Files to modify:
```
packages/orca-lang/src/parser/ast.ts              # Add decisionTables to OrcaFile
packages/orca-lang/src/parser/markdown-parser.ts   # H1 dispatch: # machine vs # decision_table
packages/orca-lang/src/verifier/types.ts           # Extend location with DT fields
packages/orca-lang/src/tools.ts                    # Add DT tool definitions
packages/orca-lang/src/skills.ts                   # Add DT skill functions (or new dt-skills.ts)
packages/orca-lang/src/index.ts                    # Export DT modules
packages/mcp-server/src/server.ts                  # Add DT tool dispatch + instructions
```

## Critical Integration Points

### 1. markdown-parser.ts — H1 Dispatch

This is the most important change. The current `parseMarkdown()` function needs to:

1. Split the source on `---` (already does this for multi-machine)
2. For each chunk, examine the H1 heading:
   - `# machine <Name>` → existing machine parsing path
   - `# decision_table <Name>` → new `parseDecisionTable()` path
3. Collect results into `OrcaFile.machines` and `OrcaFile.decisionTables`

**Look at how the existing `---` splitting works** before implementing. The DT parser should plug into the same dispatch mechanism. Don't duplicate structural parsing.

### 2. OrcaFile Backward Compatibility

Every place that constructs `OrcaFile` must now include `decisionTables: []`. Search the codebase for `OrcaFile` construction sites:

```bash
grep -rn "OrcaFile" packages/orca-lang/src/ packages/mcp-server/src/
```

Also check the runtimes — `runtime-ts`, `runtime-python`, `runtime-go` each have their own parsers that produce their own file structures. For v1, they don't need DT support, but their `OrcaFile`-equivalent types should gracefully ignore `# decision_table` chunks.

### 3. Existing Verifier Integration

The existing `analyzeFile()` function in `verifier/structural.ts` operates on `OrcaFile`. It should:
- Continue analyzing machines as before
- Additionally run DT verification on `file.decisionTables`
- Merge errors from both into the result

Or: keep machine and DT verification separate at the skill level (each skill calls its own verifier). This is simpler for v1 and avoids coupling. The combined verification (cross-referencing machines and DTs) is a v2 feature.

**Recommendation**: Keep them separate for v1. `verify_machine` only verifies machines. `verify_decision_table` only verifies decision tables. A future `verify_file` tool could do combined analysis.

## Implementation Order

1. **AST types** (`dt-ast.ts`) — define the type system
2. **Extend `OrcaFile`** (`ast.ts`) — add `decisionTables` field, update all construction sites
3. **Parser** (`dt-parser.ts` + `markdown-parser.ts` integration) — parse DTs and dispatch on H1
4. **Parser tests** — validate parsing works standalone and combined
5. **Verifier** (`dt-verifier.ts`) — completeness, consistency, redundancy, structural checks
6. **Verifier tests** — validate all error codes
7. **Compiler** (`dt-compiler.ts`) — TypeScript + JSON output
8. **Compiler tests** — validate output correctness
9. **Skills** (`skills.ts` additions or `dt-skills.ts`) — wire up the pipeline
10. **Tools** (`tools.ts` additions) — define the MCP interface
11. **MCP server** (`server.ts` additions) — expose via MCP
12. **Examples** — create `.orca.md` files exercising the full pipeline
13. **Update CLAUDE.md and AGENTS.md** — document the new document type and tools

## Key Design Decisions

- **Embedded in `.orca.md`, not separate files**: An LLM can generate machines + decision tables in one document. The `---` separator and H1 dispatch already support multiple document types. This is the architecturally clean choice given orca-lang's existing multi-document infrastructure.

- **`# decision_table` as H1 peer to `# machine`**: Clean, unambiguous dispatch. No new section types inside machines — decision tables are top-level documents, not subsections of a machine.

- **First-match as default policy**: Matches the intuition of ordered rules (like `if/else if/else`). Practical — you don't need to specify every combination if you have a catch-all rule at the bottom.

- **`→` prefix for action columns**: Visual disambiguation in the rules table. Without it, you can't tell conditions from actions by looking at the table. The `->` ASCII alternative is accepted for LLM convenience.

- **Completeness checking with size limits**: Full enumeration for small tables, skip/warn for large ones. A 20-condition table has ~1M combinations and full enumeration isn't useful.

- **No cross-references in v1**: A machine action can *conceptually* call a decision table, but the verifier doesn't enforce this link yet. The DT compiles to a standalone function that the action implementation calls. Cross-reference validation (machine action X must have a corresponding DT named Y) is a v2 feature.

- **No runtime impact in v1**: Decision tables compile to pure functions. No event bus, no effects, no state. The generated TypeScript function is a pure `input → output` mapping.

- **ActionOutputDef, not ActionDef**: The DT "actions" table defines *output fields*, not state machine actions. Different concept, different type name. Avoids confusion with `ActionSignature` from the machine AST.

## Testing Strategy

Run all tests with:
```bash
cd packages/orca-lang && pnpm test
```

The existing test runner (vitest) picks up `tests/dt-*.test.ts` files automatically.

For the MCP server:
```bash
cd packages/mcp-server && pnpm test
```

**Critical**: After implementing, verify that ALL existing tests still pass. The `OrcaFile` change touches a lot of code — run the full test suite after every phase.

## Notes for Claude Code

- The repo uses **pnpm** (not npm or yarn). Run `pnpm install` if adding dependencies.
- TypeScript config is in each package's `tsconfig.json`. The project uses ES modules (`"type": "module"` in package.json).
- Import paths use `.js` extensions (e.g., `import { foo } from './bar.js'`) per Node ESM convention.
- The `markdown-it` library is already a dependency of `orca-lang` — reuse it for the DT parser.
- Follow the existing code style — match the style of the file you're editing.
- The verifier pattern is: parse → analyze → check (multiple independent check functions returning `VerificationError[]`) → aggregate.
- **Reference files to study before implementing**:
  - `packages/orca-lang/src/parser/markdown-parser.ts` — the markdown parsing pattern and `---` splitting logic
  - `packages/orca-lang/src/parser/ast.ts` — existing AST types and `OrcaFile`
  - `packages/orca-lang/src/verifier/structural.ts` — verifier architecture pattern
  - `packages/orca-lang/src/verifier/types.ts` — error types and location structure
  - `packages/orca-lang/src/compiler/xstate.ts` — compiler output pattern
  - `packages/orca-lang/src/skills.ts` — skills wiring pattern
  - `packages/orca-lang/src/tools.ts` — MCP tool definition pattern
  - `packages/mcp-server/src/server.ts` — MCP tool dispatch pattern
  - `packages/orca-lang/docs/orca-md-grammar-spec.md` — formal grammar spec (for consistency in documentation style)