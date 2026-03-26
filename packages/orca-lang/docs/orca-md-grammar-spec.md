# Orca Markdown Grammar Specification

**Version 0.1 — March 2026**

This document defines the formal grammar for `.orca.md` files — the markdown-based syntax that replaces the custom `.orca` DSL. The markdown format produces the **same AST** as the existing parser, ensuring all downstream tooling (verifiers, compilers, runtimes) works without modification.

---

## 1. Design Goals

1. **AST equivalence.** Every `.orca` file has a semantically identical `.orca.md` representation. The markdown parser produces the same `MachineDef` AST node as the DSL parser.

2. **LLM generation accuracy.** Tables, headings, and bullet lists have near-zero structural error rates in LLM output. No custom operators (`+`, `->`, `:`) in the primary generation path.

3. **Renders without tooling.** Any markdown viewer (GitHub, VS Code, Obsidian) displays a readable machine definition.

4. **Embeddable.** A machine definition can live inside a larger markdown document (design doc, README). The parser extracts it from surrounding prose.

5. **Round-trip fidelity.** `orca convert` can migrate `.orca` → `.orca.md` and the resulting file parses to an identical AST.

---

## 2. Document Structure

### 2.1 Standalone Files

A standalone `.orca.md` file contains exactly one machine definition. The file begins with a machine heading (H1) and extends to EOF.

### 2.2 Embedded Machines

When embedded in a larger markdown document, a machine definition is delimited by:

- **Start:** An H1 heading matching `# machine <Name>`
- **End:** The next H1 heading, or EOF

Everything between these boundaries is parsed as machine content. Content before the first `# machine` heading and after the machine boundary is ignored. This allows prose to surround the machine definition naturally.

### 2.3 Section Ordering

Sections within a machine are identified by their heading text, not by position. However, the **recommended order** is:

1. `# machine Name` (required, exactly once)
2. Prose/description (optional, ignored by parser)
3. `## context` (optional)
4. `## events` (optional)
5. State headings: `## state ...` (at least one required)
6. `## transitions` (optional)
7. `## guards` (optional)
8. `## actions` (optional)
9. `## properties` (optional)

The parser accepts sections in any order, with one exception: state headings and their children must be contiguous (see §4 Scoping Rules).

---

## 3. Section Definitions

### 3.1 Machine Declaration

```markdown
# machine PaymentProcessor
```

**Grammar:**
```
machine_heading := "# machine" SP name:IDENT
```

- H1 heading, literal text `machine`, followed by a single identifier.
- The machine name follows identifier rules: `[a-zA-Z_][a-zA-Z0-9_]*`.
- Prose text following the heading (before the next `##` heading) is ignored by the parser. Authors may use this space for natural-language description of the machine's purpose.

### 3.2 Context Section

```markdown
## context

| Field | Type | Default |
|-------|------|---------|
| order_id | string | |
| amount | decimal | |
| retry_count | int | 0 |
| payment_token | string? | |
| inventory | string[] | |
```

**Grammar:**
```
context_section := "## context" NL table
table           := header_row separator_row data_row+
header_row      := "| Field | Type | Default |"      (case-insensitive column names)
data_row        := "|" field_name "|" type_expr "|" default_value? "|"
```

**Column definitions:**

| Column | Required | Content |
|--------|----------|---------|
| Field | Yes | Identifier: field name |
| Type | Yes | Type expression (see §3.2.1) |
| Default | No | Default value; empty cell = no default |

#### 3.2.1 Type Expressions

Types are written as plain text in the Type column:

| Type | Syntax | Example |
|------|--------|---------|
| String | `string` | `string` |
| Integer | `int` | `int` |
| Decimal | `decimal` | `decimal` |
| Boolean | `bool` | `bool` |
| Number | `number` | `number` |
| Array | `<type>[]` | `string[]` |
| Map | `map<K, V>` | `map<string, int>` |
| Optional | `<type>?` | `string?` |
| Custom | `<Ident>` | `User` |

Optional types may also be written with the `?` suffix on any base type: `int?`, `string[]?`.

#### 3.2.2 Default Values

| Value Type | Syntax | Example |
|------------|--------|---------|
| Number | Numeric literal | `0`, `3.14` |
| String | Quoted string | `"pending"`, `'idle'` |
| Boolean | `true` / `false` | `true` |
| Empty/none | Empty cell | *(no default)* |

### 3.3 Events Section

```markdown
## events

- submit_payment
- payment_authorized
- payment_declined
- retry_requested
- cancel_requested
```

**Grammar:**
```
events_section := "## events" NL bullet_list
bullet_list    := ("- " event_name NL)+
event_name     := IDENT ("," SP IDENT)*
```

Events are listed as a markdown bullet list. Each bullet is one event name (identifier). Multiple events may optionally appear on a single bullet, comma-separated:

```markdown
- go_north, go_south
- attack, defend, flee
```

> **Note:** Event payload types (e.g., typed event data) are not yet supported in the DSL or markdown syntax. Events are simple names; payload structure is declared implicitly via action parameter types in the `## actions` table. Typed event payloads are reserved for a future version.

### 3.4 State Sections

States are declared as headings. The heading level determines hierarchy:

| Heading Level | Meaning |
|---------------|---------|
| `## state` | Top-level state |
| `### state` | Child of preceding `## state` (hierarchical) |
| `#### state` | Grandchild (child of preceding `### state`) |
| `##### state` | Great-grandchild |

**Grammar:**
```
state_heading := heading_prefix "state" SP name:IDENT (SP annotations)?
annotations   := "[" annotation ("," SP annotation)* "]"
annotation    := "initial" | "final" | "parallel" | sync_annotation
sync_annotation := "sync:" SP? strategy
strategy      := "all-final" | "any-final" | "custom"
                 ;; "all_final" and "any_final" (with underscores) are accepted as aliases
```

**Examples:**
```markdown
## state idle [initial]
## state processing [parallel]
## state processing [parallel, sync: any-final]
## state completed [final]
```

#### 3.4.1 State Body

The content between a state heading and the next heading of equal or higher level constitutes the state body. It may contain:

**Description** — A blockquote immediately following the heading:
```markdown
## state idle [initial]
> Waiting for a payment submission
```

**State properties** — A bullet list of properties:
```markdown
## state validating
> Validating payment details
- on_entry: validate_payment_details
- on_exit: cleanup_validation
- timeout: 30s -> timed_out
- ignore: cancel_requested
- ignore: retry_requested
- on_done: -> completed
```

**Property syntax:**

| Property | Bullet Syntax | Notes |
|----------|---------------|-------|
| Entry action | `- on_entry: <action_name>` | Action executed on state entry |
| Exit action | `- on_exit: <action_name>` | Action executed on state exit |
| Timeout | `- timeout: <duration> -> <state>` | Auto-transition after duration |
| Ignore event | `- ignore: <event1>, <event2>, ...` | Events ignored in this state |
| On done | `- on_done: -> <state>` | Target state when parallel regions complete |

**Duration syntax:** `<number>s` (seconds) or `<number>ms` (milliseconds) or bare `<number>` (milliseconds).

**Multiple ignore directives** may appear as separate bullets or comma-separated on one bullet:
```markdown
- ignore: PAYMENT_SUCCESS, PAYMENT_FAILED
- ignore: EMAIL_SENT
```

#### 3.4.2 Hierarchical (Compound) States

A state with child state headings at the next heading level is a compound state:

```markdown
## state exploration
> Player is exploring the world

### state overworld [initial]
> Player is in the overworld

### state dungeon
> Player is in a dungeon

## state combat
> Player is in combat
```

**Scoping rule:** `### state overworld` and `### state dungeon` are children of `## state exploration` because they are at the next heading level and appear before `## state combat` (which is at the same level as their parent, closing the parent scope). See §4 for full scoping rules.

**Constraints:**
- A compound state must have exactly one `[initial]` child.
- A `[final]` state cannot be compound (cannot have children).

#### 3.4.3 Parallel States

A state annotated with `[parallel]` contains parallel regions instead of sequential child states:

```markdown
## state processing [parallel, sync: all-final]
> Order is being processed
- on_entry: initializeOrder
- on_done: -> completed
- ignore: PLACE_ORDER

### region payment_flow

#### state charging [initial]
> Attempting to charge the customer
- on_entry: chargePayment

#### state payment_failed
> Payment failed, can retry

#### state paid [final]
> Payment has been received
- on_entry: recordPayment

### region notification_flow

#### state sending_email [initial]
> Sending order confirmation email
- on_entry: sendConfirmationEmail

#### state sending_sms
> Sending SMS notification
- on_entry: sendSmsNotification

#### state notified [final]
> All notifications sent
```

**Grammar:**
```
parallel_state  := heading_prefix "state" SP name "[parallel" ("," SP sync_annotation)? "]"
region_heading  := heading_prefix "region" SP name:IDENT
region_state    := heading_prefix "state" SP name:IDENT (SP annotations)?
```

**Rules:**
- The parallel state heading uses `[parallel]` or `[parallel, sync: <strategy>]`.
- Regions are headings at one level below the parallel state: `### region` under `## state`.
- States within a region are headings at one level below the region: `#### state` under `### region`.
- Each region must have exactly one `[initial]` state.
- Sync strategies: `all-final` (default), `any-final`, `custom`. Both hyphenated (`all-final`) and underscored (`all_final`) forms are accepted; hyphenated is canonical.
- `on_done: -> <state>` on the parallel state specifies the target when sync completes.
- Nested parallel (parallel inside a region) is disallowed in v1. The parser emits an error if a `[parallel]` annotation appears inside a region.

**Heading level consumption for parallel:**

| Level | Content |
|-------|---------|
| H2 | `## state processing [parallel]` |
| H3 | `### region payment_flow` |
| H4 | `#### state charging [initial]` |

If a parallel state is itself nested inside a compound state (e.g., `### state processing [parallel]` under `## state active`), the regions shift down accordingly (H4 regions, H5 states). Maximum depth is constrained by H6.

### 3.5 Transitions Section

```markdown
## transitions

| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| idle | submit_payment | | validating | initialize_payment |
| validating | payment_authorized | | authorizing | prepare_auth_request |
| declined | retry_requested | can_retry | validating | increment_retry |
| declined | retry_requested | !can_retry | failed | set_max_retries_error |
| declined | cancel_requested | | failed | |
| authorized | settlement_confirmed | | settled | |
```

**Grammar:**
```
transitions_section := "## transitions" NL table
table               := header_row separator_row data_row+
header_row          := "| Source | Event | Guard | Target | Action |"
data_row            := "|" source "|" event "|" guard? "|" target "|" action? "|"
```

**Column definitions:**

| Column | Required | Content |
|--------|----------|---------|
| Source | Yes | State name (identifier or dot-notation) |
| Event | Yes | Event name (identifier) |
| Guard | No | Guard reference; empty = unguarded |
| Target | Yes | State name (identifier or dot-notation) |
| Action | No | Action name; empty or `_` = no action |

#### 3.5.1 Guard References in Transitions

The Guard column accepts:

| Form | Meaning | Example |
|------|---------|---------|
| Empty | Unguarded transition | |
| `name` | Guard must be true | `can_retry` |
| `!name` | Guard must be false | `!can_retry` |

Only named guard references are allowed in the transitions table. Complex expressions are defined in the guards section and referenced by name here.

#### 3.5.2 State References (Dot Notation)

Source and Target columns support dot-notation for hierarchical state references:

```markdown
| exploration.overworld | go_north | | exploration.dungeon | move_north |
```

However, **simple names** are preferred when unambiguous. The parser resolves simple names against the full state tree. Dot-notation is only required when a state name is ambiguous (e.g., two different compound states each have a child named `idle`).

#### 3.5.3 Parent-Level Transitions

A transition with a compound state as Source applies to all children of that state (Harel statechart semantics):

```markdown
| exploration | game_over_trigger | | game_over | |
```

This means: "from any state inside `exploration`, if `game_over_trigger` occurs, transition to `game_over`."

#### 3.5.4 No-Action Transitions

An empty Action cell or `_` both mean "no action executed":

```markdown
| idle | start_game | | exploration | |
| idle | start_game | | exploration | _ |
```

Both are equivalent.

### 3.6 Guards Section

```markdown
## guards

| Name | Expression |
|------|------------|
| can_retry | `ctx.retry_count < 3` |
| has_valid_token | `ctx.payment_token != null` |
| is_high_value | `ctx.amount > 10000` |
| complex_guard | `(ctx.health > 0 and ctx.ammo > 0) or ctx.mode == "god"` |
```

**Grammar:**
```
guards_section := "## guards" NL table
header_row     := "| Name | Expression |"
data_row       := "|" guard_name "|" backtick_expr "|"
backtick_expr  := "`" guard_expression "`"
```

**Rules:**
- Guard names are identifiers.
- Expressions are wrapped in backticks (inline code) within the table cell. This prevents markdown from interpreting operators like `<`, `>`, `|` as formatting.
- The expression inside backticks follows the same guard expression grammar as the current DSL (see §5.1).

### 3.7 Actions Section

```markdown
## actions

| Name | Signature |
|------|-----------|
| reset_context | `(ctx: Context) -> Context` |
| initialize_payment | `(ctx: Context, event: SubmitPayment) -> Context` |
| send_auth_request | `(ctx: Context) -> Context + Effect<AuthRequest>` |
```

**Grammar:**
```
actions_section := "## actions" NL table
header_row      := "| Name | Signature |"
data_row        := "|" action_name "|" backtick_sig "|"
backtick_sig    := "`" action_signature "`"
```

**Signature syntax** (inside backticks):
```
signature    := "(" params? ")" SP "->" SP return_type effect?
params       := param ("," SP param)*
param        := name (":" SP type)?
return_type  := IDENT
effect       := SP "+" SP "Effect<" IDENT ">"
```

**Rules:**
- Action names are identifiers.
- Signatures are wrapped in backticks within the table cell.
- Parameter type annotations are optional (e.g., `(ctx)` and `(ctx: Context)` both valid).
- The `_` no-op action is not declared in the actions table — it is implicit.

### 3.8 Properties Section

```markdown
## properties

- reachable: authorized from idle
- unreachable: settled from failed
- passes_through: authorized for idle -> settled
- live
- responds: settled from idle within 5
- invariant: `ctx.retry_count <= 3`
- invariant: `ctx.health > 0` in combat
```

**Grammar:**
```
properties_section := "## properties" NL bullet_list
property           := "- " property_body

property_body      := reachable_prop | unreachable_prop | passes_through_prop
                    | live_prop | responds_prop | invariant_prop

reachable_prop     := "reachable:" SP target SP "from" SP source
unreachable_prop   := "unreachable:" SP target SP "from" SP source
passes_through_prop := "passes_through:" SP through SP "for" SP source SP "->" SP target
live_prop          := "live"
responds_prop      := "responds:" SP target SP "from" SP source SP "within" SP bound:NUMBER
invariant_prop     := "invariant:" SP backtick_expr (SP "in" SP state_name)?
```

**Rules:**
- Properties are listed as a markdown bullet list.
- State references in properties support dot-notation for hierarchical states.
- Invariant expressions are wrapped in backticks (consistent with guard expression formatting).
- The `->` in `passes_through` is kept because it represents a directional path (from → to), which is semantically meaningful.

**Property semantics:**

| Property | Meaning |
|----------|---------|
| `reachable: B from A` | There exists a path from state A to state B in the state graph |
| `unreachable: B from A` | No path exists from state A to state B |
| `passes_through: M for A -> B` | Every path from A to B passes through state M |
| `live` | The machine has no trap states — every non-final state has at least one outgoing transition path that can eventually reach a final state |
| `responds: B from A within N` | State B is reachable from state A within N transitions (bounded response) |
| `invariant: expr` | The guard expression `expr` is expected to hold in all reachable states (advisory — verified at topology level only, not runtime) |
| `invariant: expr in S` | Same, but scoped to state S only |

All properties are checked by the bounded model checker via BFS on the flattened state graph. Guard-aware checking prunes transitions with statically-false guards. Counterexample traces are provided on failure.

---

## 4. Scoping Rules

Markdown headings lack explicit closing markers. This section defines how the parser determines parent-child relationships.

### 4.1 Heading Level Hierarchy

The heading level establishes a strict containment hierarchy:

```
H1  # machine Name           ← machine scope
H2  ## state/context/etc.    ← top-level sections
H3  ### state/region         ← children of H2 state, or regions of H2 parallel state
H4  #### state               ← children of H3 state/region
H5  ##### state              ← children of H4 state
H6  ###### state             ← children of H5 state (maximum depth)
```

### 4.2 Scope Termination

A heading at level N **closes all open scopes at level ≥ N**. Formally:

> When the parser encounters a heading at level N, every state/region scope opened by a heading at level N or deeper is closed.

**Example:**
```markdown
## state exploration           ← opens scope at H2
### state overworld [initial]  ← opens child scope at H3
### state dungeon              ← closes overworld (H3≥H3), opens dungeon at H3
## state combat                ← closes dungeon (H2≥H3) AND exploration (H2≥H2)
### state attacking [initial]  ← opens child scope at H3 (under combat)
```

### 4.3 Non-State Sections as Scope Terminators

A non-state H2 heading (`## transitions`, `## guards`, etc.) terminates any open state scope:

```markdown
## state idle [initial]        ← opens state scope
> Description
## transitions                 ← closes idle state scope, starts transitions section
```

### 4.4 Contiguity Requirement

All state headings for a given parent must be contiguous. The parser does not support interleaving state definitions with other sections:

```markdown
## state idle [initial]
## transitions            ← this closes state definitions
## state processing       ← ERROR: state after non-state section
```

**Correct structure:**
```markdown
## state idle [initial]
## state processing
## transitions
```

> **Rationale:** Contiguity makes the document predictable for both humans and parsers. States form a visual group; mixing them with transition tables would harm readability.

**Exception:** Prose text (paragraphs, not headings) between state headings is allowed and ignored:

```markdown
## state idle [initial]
> Waiting for input

The idle state is the entry point for new sessions.

## state processing
> Actively working
```

### 4.5 Region Scoping

Regions within a parallel state follow the same scoping rules:

```markdown
## state processing [parallel]       ← H2 parallel state
### region payment_flow              ← H3 region (child of processing)
#### state charging [initial]        ← H4 state (child of payment_flow)
#### state paid [final]              ← H4 state (closes charging, child of payment_flow)
### region notification_flow         ← H3 region (closes payment_flow region)
#### state sending [initial]         ← H4 state (child of notification_flow)
#### state notified [final]          ← H4 state (child of notification_flow)
## state completed [final]           ← H2 state (closes notification_flow, processing)
```

### 4.6 Maximum Nesting Depth

Markdown provides heading levels H1–H6. With H1 reserved for the machine declaration, and H2 for top-level sections, the maximum nesting depth for states is **4 levels** (H3 through H6):

| Level | Use |
|-------|-----|
| H1 | Machine declaration |
| H2 | Top-level states and non-state sections |
| H3 | Child states or regions |
| H4 | Grandchild states or region-internal states |
| H5 | Great-grandchild states |
| H6 | 4th-level nested states (maximum) |

Combined with the 64-state machine size limit, this is sufficient for all practical machines. Machines requiring deeper nesting should be decomposed into multiple machines.

---

## 5. Validation Constraints

The markdown parser enforces the same structural constraints as the DSL parser. These are checked during parsing or immediately after AST construction.

### 5.1 Structural Constraints

| Constraint | Error | Description |
|------------|-------|-------------|
| Exactly one `[initial]` state per machine | `MISSING_INITIAL` | The machine must have exactly one top-level initial state |
| Exactly one `[initial]` state per compound state | `MISSING_INITIAL` | Each compound (hierarchical) state must have one initial child |
| Exactly one `[initial]` state per region | `MISSING_INITIAL` | Each parallel region must have one initial state |
| `[final]` states cannot be compound | `FINAL_WITH_CHILDREN` | A final state cannot have child states or parallel regions |
| No nested parallel | `NESTED_PARALLEL` | A `[parallel]` state cannot appear inside a parallel region (v1 restriction) |
| Machine size limit | `MACHINE_TOO_LARGE` | Flattened state count must not exceed 64 (configurable) |
| State names unique within scope | `DUPLICATE_STATE` | No two sibling states may share a name |
| Region names unique within parallel | `DUPLICATE_REGION` | No two regions in the same parallel block may share a name |
| At least 2 regions in parallel | `INSUFFICIENT_REGIONS` | A parallel state should have at least 2 regions |

### 5.2 Transition Constraints

| Constraint | Error | Description |
|------------|-------|-------------|
| Source state exists | `UNKNOWN_STATE` | Transition source must reference a defined state |
| Target state exists | `UNKNOWN_STATE` | Transition target must reference a defined state |
| Guard exists | `UNKNOWN_GUARD` | Guard reference must match a defined guard name |
| Determinism | `NONDETERMINISTIC` | Multiple transitions from same (state, event) must have mutually exclusive guards |
| Completeness | `INCOMPLETE` | Every (state, event) pair must be handled or explicitly ignored |

### 5.3 Heading Level Constraints

| Constraint | Error | Description |
|------------|-------|-------------|
| H1 reserved for machine | `INVALID_HEADING` | Only `# machine Name` may use H1 |
| No heading level skips | `INVALID_HEADING` | Cannot jump from H2 to H4 without H3 in between |
| Maximum H6 depth | `NESTING_TOO_DEEP` | States cannot be nested beyond H6 |
| State contiguity | `STATE_ORDER` | All state headings for a scope must be contiguous (no interleaving with `## transitions`, etc.) |

---

## 6. Micro-Grammars

Table cells and bullet items contain structured content that requires micro-parsing. These grammars are small and isolated — the markdown parser handles document structure, and micro-parsers handle cell/item content.

### 6.1 Guard Expression Grammar

Guard expressions appear in the `## guards` table (in backticks) and in `## properties` invariants (in backticks).

```
expression     := or_expr
or_expr        := and_expr ("or" and_expr)*
and_expr       := not_expr ("and" not_expr)*
not_expr       := "not" not_expr | primary
primary        := "(" expression ")"
               | variable comparison_op value
               | variable "is" "null"
               | variable "is" "not" "null"
               | variable                      -- truthy check
               | "true"
               | "false"

comparison_op  := "==" | "!=" | "<" | ">" | "<=" | ">="
variable       := IDENT ("." IDENT)*
value          := NUMBER | STRING | "true" | "false" | "null"
```

**Operator precedence** (highest to lowest):
1. Parentheses `()`
2. NOT `not`
3. Comparisons `==`, `!=`, `<`, `>`, `<=`, `>=`
4. AND `and`
5. OR `or`

**Notes:**
- `&&` and `||` are accepted as aliases for `and` and `or` respectively.
- Guard expressions inside backticks are protected from markdown table formatting issues (no conflict with `|` pipe characters since they're in inline code).
- String literals support both double quotes (`"text"`) and single quotes (`'text'`) inside guard expressions.
- The `variable "is" "null"` and `variable "is" "not" "null"` forms are **reserved for future implementation**. The current DSL parser uses `variable != null` and `variable == null` for null checks. The markdown parser should support both forms, with `!= null` / `== null` as the canonical style for v1.

### 6.2 Action Signature Grammar

Action signatures appear in the `## actions` table (in backticks).

```
signature    := "(" params? ")" "->" return_type effect?
params       := param ("," param)*
param        := IDENT (":" type)?
return_type  := IDENT
effect       := "+" "Effect<" IDENT ">"
type         := IDENT ("[]")? ("?")?
```

**Parameter extraction:** The parser extracts parameter names from the signature and stores them as a `string[]` in the AST's `ActionSignature.parameters` field. Type annotations on parameters are parsed but not enforced at the topology layer — they serve as documentation and are used during action code generation. For example, `(ctx: Context, event: SubmitPayment)` produces `parameters: ["ctx", "event"]`.

### 5.3 Transition Row Grammar

Each data row in the `## transitions` table:

```
source_cell  := state_ref
event_cell   := IDENT
guard_cell   := "" | IDENT | "!" IDENT
target_cell  := state_ref
action_cell  := "" | "_" | IDENT

state_ref    := IDENT ("." IDENT)*
```

### 5.4 Property Grammar

Each bullet in the `## properties` list:

```
property     := "reachable:" state_ref "from" state_ref
             | "unreachable:" state_ref "from" state_ref
             | "passes_through:" state_ref "for" state_ref "->" state_ref
             | "live"
             | "responds:" state_ref "from" state_ref "within" NUMBER
             | "invariant:" backtick_expr ("in" state_ref)?

state_ref    := IDENT ("." IDENT)*
backtick_expr := "`" guard_expression "`"
```

### 5.5 Duration Grammar

Durations appear in timeout property bullets:

```
duration     := NUMBER unit?
unit         := "s" | "ms"
```

- Bare number (no unit): milliseconds
- `s` suffix: seconds (multiplied by 1000)
- `ms` suffix: milliseconds (explicit)

---

## 7. Syntax Mapping Reference

Complete mapping from current `.orca` DSL to `.orca.md` markdown:

| DSL Construct | Markdown Equivalent | Section |
|---|---|---|
| `machine Name` | `# machine Name` | §3.1 |
| `context { field: type = default }` | `## context` + table (Field, Type, Default) | §3.2 |
| `events { e1, e2 }` | `## events` + bullet list | §3.3 |
| `state name [initial] { ... }` | `## state name [initial]` + blockquote + bullets | §3.4 |
| `state name [final] { ... }` | `## state name [final]` | §3.4 |
| `description: "text"` | `> text` (blockquote) | §3.4.1 |
| `on_entry: -> action` | `- on_entry: action` | §3.4.1 |
| `on_exit: -> action` | `- on_exit: action` | §3.4.1 |
| `timeout: 5s -> state` | `- timeout: 5s -> state` | §3.4.1 |
| `ignore: event` | `- ignore: event` | §3.4.1 |
| `on_done: -> state` | `- on_done: -> state` | §3.4.1 |
| Nested `state child [initial] { ... }` | `### state child [initial]` (heading level nesting) | §3.4.2 |
| `parallel [sync: strategy] { ... }` | `## state name [parallel, sync: strategy]` | §3.4.3 |
| `region name { ... }` | `### region name` (heading under parallel state) | §3.4.3 |
| `src + event [guard] -> target : action` | Table row: `\| src \| event \| guard \| target \| action \|` | §3.5 |
| `guard_name: expression` | Table row: `\| guard_name \| \`expression\` \|` | §3.6 |
| `action_name: signature` | Table row: `\| action_name \| \`signature\` \|` | §3.7 |
| `properties { ... }` | `## properties` + bullet list | §3.8 |
| `# comment` | Standard markdown (ignored by parser, or HTML comment `<!-- -->`) | — |

---

## 8. Complete Examples

### 7.1 Simple Toggle (Minimal Machine)

```markdown
# machine SimpleToggle

## events

- toggle

## state off [initial]
> Light is off

## state on
> Light is on

## transitions

| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| off | toggle | | on | |
| on | toggle | | off | |
```

### 7.2 Payment Processor (Guards, Effects, Properties)

```markdown
# machine PaymentProcessor

This machine handles the full payment lifecycle with retry logic, authorization,
and settlement. Declined payments can be retried up to 3 times.

## context

| Field | Type | Default |
|-------|------|---------|
| order_id | string | |
| amount | decimal | |
| currency | string | |
| retry_count | int | 0 |
| payment_token | string? | |
| error_message | string? | |

## events

- submit_payment
- payment_authorized
- payment_declined
- payment_timeout
- retry_requested
- cancel_requested
- refund_requested
- settlement_confirmed

## state idle [initial]
> Waiting for a payment submission
- on_entry: reset_context

## state validating
> Validating payment details before authorization
- on_entry: validate_payment_details
- timeout: 5s -> declined

## state authorizing
> Waiting for payment gateway response
- on_entry: send_authorization_request
- timeout: 30s -> declined

## state authorized
> Payment authorized, awaiting settlement
- on_entry: log_authorization

## state declined
> Payment was declined by the gateway
- on_entry: format_decline_reason

## state failed [final]
> Terminal failure state
- on_entry: record_failure

## state settled [final]
> Payment fully settled
- on_entry: record_settlement

## transitions

| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| idle | submit_payment | | validating | initialize_payment |
| validating | payment_authorized | | authorizing | prepare_auth_request |
| validating | payment_declined | | declined | |
| authorizing | payment_authorized | | authorized | record_auth_code |
| authorizing | payment_declined | | declined | increment_retry |
| authorizing | payment_timeout | | declined | set_timeout_error |
| declined | retry_requested | can_retry | validating | increment_retry |
| declined | retry_requested | !can_retry | failed | set_max_retries_error |
| declined | cancel_requested | | failed | |
| authorized | settlement_confirmed | | settled | |
| authorized | refund_requested | | failed | process_refund |

## guards

| Name | Expression |
|------|------------|
| can_retry | `ctx.retry_count < 3` |
| has_valid_token | `ctx.payment_token != null` |

## actions

| Name | Signature |
|------|-----------|
| reset_context | `() -> Context` |
| initialize_payment | `(ctx: Context, event: SubmitPayment) -> Context` |
| validate_payment_details | `(ctx: Context) -> Context` |
| send_authorization_request | `(ctx: Context) -> Context + Effect<AuthRequest>` |
| prepare_auth_request | `(ctx: Context) -> Context` |
| record_auth_code | `(ctx: Context, event: PaymentAuthorized) -> Context` |
| increment_retry | `(ctx: Context) -> Context` |
| set_timeout_error | `(ctx: Context) -> Context` |
| set_max_retries_error | `(ctx: Context) -> Context` |
| format_decline_reason | `(ctx: Context, event: PaymentDeclined) -> Context` |
| process_refund | `(ctx: Context) -> Context + Effect<RefundRequest>` |
| record_failure | `(ctx: Context) -> Context` |
| log_authorization | `(ctx: Context) -> Context` |
| record_settlement | `(ctx: Context) -> Context` |

## properties

- passes_through: authorized for idle -> settled
- unreachable: settled from failed
- reachable: authorized from idle
- live
- responds: settled from idle within 5
- invariant: `ctx.retry_count <= 3`
```

### 7.3 Hierarchical Game (Nested States)

```markdown
# machine HierarchicalGame

A text adventure game with hierarchical states for exploration, combat,
and inventory management.

## context

| Field | Type | Default |
|-------|------|---------|
| current_room | string | |
| inventory | string[] | |
| health | int | 100 |
| enemy_health | int | 50 |
| selected_item | string | |

## events

- start_game
- go_north, go_south
- look
- attack, defend, use_item, flee
- open_inventory, close_inventory, select_item
- game_over_trigger

## state idle [initial]
> Player is idle at the main menu
- on_entry: display_menu

## state exploration
> Player is exploring the world

### state overworld [initial]
> Player is in the overworld

### state dungeon
> Player is in a dungeon

## state combat
> Player is in combat

### state attacking [initial]
> Player is attacking

### state defending
> Player is defending

### state using_item
> Player is using an item

## state inventory
> Player has inventory open

### state closed [initial]
> Inventory is closed

### state open
> Inventory is open and visible

### state selecting
> Player is selecting an item

## state game_over [final]
> Game has ended

## transitions

| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| idle | start_game | | exploration | |
| exploration | go_north | | exploration | move_north |
| exploration | go_south | | exploration | move_south |
| exploration | look | | exploration | describe_location |
| exploration | attack | enemy_present | combat | |
| exploration | open_inventory | | inventory | |
| combat | attack | | combat | resolve_attack |
| combat | defend | | combat | start_defend |
| combat | use_item | item_in_inventory | combat | use_item_action |
| combat | flee | can_flee | exploration | flee_combat |
| inventory | close_inventory | | exploration | close_inv |
| inventory | select_item | | inventory | select_item_action |
| exploration | game_over_trigger | | game_over | |
| combat | game_over_trigger | | game_over | |

## guards

| Name | Expression |
|------|------------|
| enemy_present | `true` |
| can_flee | `true` |
| item_in_inventory | `true` |

## actions

| Name | Signature |
|------|-----------|
| display_menu | `(ctx: Context) -> Context` |
| move_north | `(ctx: Context) -> Context` |
| move_south | `(ctx: Context) -> Context` |
| describe_location | `(ctx: Context) -> Context` |
| resolve_attack | `(ctx: Context) -> Context` |
| start_defend | `(ctx: Context) -> Context` |
| use_item_action | `(ctx: Context) -> Context` |
| flee_combat | `(ctx: Context) -> Context` |
| close_inv | `(ctx: Context) -> Context` |
| select_item_action | `(ctx: Context) -> Context` |
```

### 7.4 Parallel Order Processor (Parallel Regions)

```markdown
# machine ParallelOrderProcessor

Order processing with payment and notification flows running concurrently.
The order completes when both payment is received and all notifications are sent.

## context

| Field | Type | Default |
|-------|------|---------|
| order_id | string | |
| payment_status | string | |
| notification_status | string | |
| amount | number | 0 |

## events

- PLACE_ORDER
- PAYMENT_SUCCESS
- PAYMENT_FAILED
- EMAIL_SENT
- SMS_SENT
- RETRY_PAYMENT
- CANCEL

## state idle [initial]
> Waiting for an order to be placed
- ignore: PAYMENT_SUCCESS, PAYMENT_FAILED, EMAIL_SENT, SMS_SENT, RETRY_PAYMENT, CANCEL

## state processing [parallel]
> Order is being processed with payment and notification in parallel
- on_entry: initializeOrder
- on_done: -> completed
- ignore: PLACE_ORDER

### region payment_flow

#### state charging [initial]
> Attempting to charge the customer
- on_entry: chargePayment

#### state payment_failed
> Payment failed, can retry

#### state paid [final]
> Payment has been received
- on_entry: recordPayment

### region notification_flow

#### state sending_email [initial]
> Sending order confirmation email
- on_entry: sendConfirmationEmail

#### state sending_sms
> Sending SMS notification
- on_entry: sendSmsNotification

#### state notified [final]
> All notifications sent

## state completed [final]
> Order fully processed and customer notified
- on_entry: completeOrder

## state cancelled [final]
> Order was cancelled during processing
- on_entry: refundIfNeeded

## transitions

| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| idle | PLACE_ORDER | | processing | validateOrder |
| charging | PAYMENT_SUCCESS | | paid | |
| charging | PAYMENT_FAILED | | payment_failed | |
| payment_failed | RETRY_PAYMENT | | charging | |
| sending_email | EMAIL_SENT | | sending_sms | |
| sending_sms | SMS_SENT | | notified | |
| processing | CANCEL | | cancelled | |

## guards

| Name | Expression |
|------|------------|
| hasValidAmount | `ctx.amount > 0` |

## actions

| Name | Signature |
|------|-----------|
| validateOrder | `(ctx, event) -> Context` |
| initializeOrder | `(ctx) -> Context` |
| chargePayment | `(ctx) -> Context + Effect<PaymentCharge>` |
| recordPayment | `(ctx) -> Context` |
| sendConfirmationEmail | `(ctx) -> Context + Effect<EmailSend>` |
| sendSmsNotification | `(ctx) -> Context + Effect<SmsSend>` |
| completeOrder | `(ctx) -> Context` |
| refundIfNeeded | `(ctx) -> Context + Effect<PaymentRefund>` |
```

---

## 9. Parser Implementation Notes

### 8.1 Two-Phase Parsing

The markdown parser operates in two phases:

1. **Structural parse:** Use a markdown library (markdown-it for TS, markdown-it-py for Python) to extract the document into a typed structure:
   - Heading nodes (level, text)
   - Table nodes (header row, data rows)
   - Bullet list nodes (items)
   - Blockquote nodes (text)

2. **Semantic parse:** Walk the structural output, dispatch on heading text patterns (`## context`, `## state idle [initial]`, `## transitions`, etc.), and apply micro-parsers (§5) to cell/item content to produce AST nodes.

This separation means the markdown parser handles all whitespace, table alignment, and formatting concerns. The semantic layer only deals with clean, extracted content.

### 8.2 Library Choice

| Language | Library | Rationale |
|----------|---------|-----------|
| TypeScript | `markdown-it` | Lightweight, excellent table plugin, widely used |
| Python | `markdown-it-py` | Direct port of markdown-it; consistent parsing behavior |

Both libraries use the same parsing algorithm, ensuring identical structural output across languages. This is critical for cross-runtime consistency.

### 8.3 Error Reporting

The markdown parser must provide clear error messages with location information:

```
error: missing [initial] state in region "payment_flow"
  --> payment-processor.orca.md:45 (### region payment_flow)

error: unknown column "Actions" in transitions table (expected "Action")
  --> payment-processor.orca.md:62 (## transitions)

error: guard expression syntax error in guards table row 3
  --> payment-processor.orca.md:78: `ctx.amount >< 100`
                                                 ^^ expected comparison operator
```

Line numbers should reference the original markdown file, not internal structures.

### 8.4 Lenient vs Strict Mode

The parser should support two modes:

- **Strict mode** (default for `orca verify`): Requires exact column names, rejects unknown sections, enforces contiguity.
- **Lenient mode** (for embedded documents): Ignores unknown headings, tolerates minor column name variations (case-insensitive matching), skips non-machine content.

### 8.5 Reusing Existing Micro-Parsers

The guard expression parser from the current DSL can be reused directly. The `parseGuardExpression()` function (and its helper methods `parseGuardOr`, `parseGuardAnd`, `parseGuardNot`, `parseGuardPrimary`) operates on a token stream — the markdown parser just needs to tokenize the backtick-extracted string and feed it to the same functions.

Similarly, `parseType()` for context field types and the action signature parser can be extracted and reused.

---

## 10. Migration Tooling

### 9.1 `orca convert` Command

```bash
# Convert single file
orca convert payment-processor.orca

# Convert with output path
orca convert payment-processor.orca -o payment-processor.orca.md

# Convert all examples
orca convert examples/*.orca
```

The converter:
1. Parses the `.orca` file with the existing parser
2. Produces the `.orca.md` output from the AST
3. Verifies round-trip: parses the output with the markdown parser and asserts AST equality

### 9.2 Dual-Format Support Period

During migration, both parsers coexist:

- File extension `.orca` → DSL parser
- File extension `.orca.md` or `.md` → Markdown parser
- All CLI commands (`verify`, `compile`, `convert`) auto-detect format by extension
- The `orca verify` command validates identical AST when both formats exist for the same machine

### 9.3 AST Equivalence Testing

A test helper validates that every example file produces identical ASTs from both formats:

```typescript
function assertFormatEquivalence(orcaPath: string, mdPath: string) {
  const dslAst = parseOrca(readFileSync(orcaPath, 'utf-8'));
  const mdAst  = parseOrcaMd(readFileSync(mdPath, 'utf-8'));
  expect(mdAst).toEqual(dslAst);
}
```

This runs as part of the test suite for every example file.

---

## 11. Differences from Current DSL

### 10.1 Syntax Changes

| Aspect | DSL | Markdown | Rationale |
|--------|-----|----------|-----------|
| Block delimiters | `{ }` braces | Heading levels | Markdown-native structure |
| Transition format | `src + event [guard] -> target : action` | Table row with named columns | Eliminates custom operators |
| Guard format | `name: expression` | Table row with backtick expression | Structured, renders cleanly |
| State properties | `on_entry: -> action` | `- on_entry: action` | Bullet list, drop redundant `->` |
| Comments | `# comment` | Standard markdown or `<!-- -->` | `#` is heading syntax in markdown |
| Parallel blocks | `parallel { region X { ... } }` | `[parallel]` annotation + `### region` headings | Heading-level structure |
| Description | `description: "text"` | `> text` (blockquote) | Markdown-native formatting |

### 10.2 Semantic Equivalence

All semantic constructs are preserved:
- Same AST types produced
- Same verifier rules apply
- Same compilation targets work
- Same property checking behavior
- Same guard expression grammar

### 10.3 What's NOT Changing

- Guard expression syntax (inside backticks, same grammar)
- Action signature syntax (inside backticks, same grammar)
- State annotation syntax (`[initial]`, `[final]`)
- Event names, state names, guard names, action names
- Verifier, compiler, runtime behavior
- Property specification syntax (moved from braces to bullets)

---

## 12. Open Questions

1. **Table column ordering:** Should the parser enforce a specific column order in tables, or allow any permutation (matching by column header name)? **Recommendation:** Match by header name, ignore order.

2. **Extra columns:** Should the transitions table allow extra columns (e.g., a "Notes" column for human documentation)? **Recommendation:** Yes, ignore unknown columns in lenient mode; warn in strict mode.

3. **Inline transitions in state bodies:** Should states support inline transition bullets (`- on submit_payment -> validating : action`) as a shorthand for simple machines? **Recommendation:** Defer to v2. Keep transitions in the global table for v1.

4. **Multiple machines per file:** Should `.orca.md` files support multiple `# machine` headings? **Recommendation:** Yes, for embedded-in-docs use cases. Each `# machine` starts a new machine scope. The CLI processes them independently.

5. **Markdown extensions:** Should we support any markdown extensions (e.g., admonitions, custom containers)? **Recommendation:** No. Stick to CommonMark + tables (GFM tables). No extensions required.
