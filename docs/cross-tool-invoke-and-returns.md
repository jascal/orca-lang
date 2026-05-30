# Cross-Tool Invocation: Typed Returns + Bridging to q-orca

## Problem Statement

Orca supports machine invocation (`- invoke: Child`) with `input:` mapping and
`on_done` / `on_error` events. A child returns implicitly as
`{ finalState, context }`, which the parent inspects in its `on_done` handler.
That is enough for same-tool, classical-only composition, but it has two gaps:

1. **Returns are untyped and implicit.** The parent must pattern-match on
   `finalState` and reach into `context` by hand. There is no declared,
   verifiable contract for *what a machine returns* — so a typo or a shape change
   in the child is caught at runtime, not at parse/verify time.

2. **No bridge to the quantum sibling.** The sister tool **q-orca** (Python) has
   shipped a richer composition story: parameterized `invoke: Child(args)
   shots=N`, a typed `## returns` section with per-return statistics
   (`expectation` / `histogram` / `variance`), cross-file imports, and an
   executor (`run_composed` / `q-orca run`). The motivating hybrid workflow — a
   **classical orca trainer loop** driving a **q-orca quantum forward pass** —
   cannot be expressed because orca has no way to declare typed returns, request
   shot-batched statistics, or invoke a machine owned by the other tool.

q-orca has specified a tool-agnostic **bridge protocol** for exactly this
(`q-orca-lang/openspec/changes/add-cross-tool-bridge-protocol`). This document
proposes orca's side: add typed returns, extend invoke for return bindings and
shots, and implement the bridge.

---

## Goals / Non-Goals

**Goals:**

- A typed `## returns` section so a machine declares what it hands back, checked
  at parse/verify time.
- Extend `- invoke:` with return bindings and an optional `shots:` modifier (for
  measurement-bearing foreign children), keeping the existing bullet syntax.
- Implement the q-orca bridge protocol on orca's side so an orca parent can
  invoke a q-orca child (and orca machines can be invoked *by* q-orca).
- Full backward compatibility: machines with no `## returns` behave exactly as
  today (implicit `{ finalState, context }`).

**Non-Goals:**

- A shared AST or in-process FFI with q-orca (decision **1b — bridge layer, not
  shared AST**). The boundary is process + JSON.
- Changing orca's runtime model for same-tool classical invokes beyond the
  additive returns/bindings.
- Quantum semantics inside orca — quantum work always lives in the q-orca child;
  orca only orchestrates and reads back classical / aggregated values.

---

## Proposed Changes

### 1. Typed `## returns` section

A machine MAY declare what it returns. `Name` is a context field (or, for a
bridged quantum child, a measured-bit reference like `bits[0]`); `Type` uses the
existing context type grammar; `Statistics` is allowed only on a
measurement-bearing (quantum) machine.

```md
## returns

| Name      | Type | Statistics             |
|-----------|------|------------------------|
| converged | bool |                        |
```

AST: add `ReturnDef { name: string; type: string; statistics: string[] }` and
`returns?: ReturnDef[]` on `MachineDef`. Absent section → empty, and the parent
falls back to the current `{ finalState, context }` behavior.

**Name collisions.** A declared return name is a *child-side* label; it lives in
the child's namespace and never shadows a parent context field. On the parent
side, `- returns: { parent_field: child_return }` writes into `parent_field`,
which MUST be a declared parent context field — if it isn't, the verifier emits
an error (it does not silently create a field). A synthesized aggregate name
(`prob_<r>`) colliding with an existing same-typed parent field is treated as an
intentional reuse; a type mismatch is a verify error.

### 2. Invoke return bindings + `shots:`

Extend `InvokeDef` with:

Inline form (preferred for the common case — keeps a simple invoke on one line):

```md
## state training
- invoke: QForward input: { theta: ctx.theta } shots: 1024 returns: { prob: prob_bits_0 }
- on_done: STEP_DONE
```

Multi-line form (for many bindings; `input:` / `shots:` / `returns:` may each sit
on their own `- invoke …` continuation):

```md
## state training
- invoke: QForward input: { theta: ctx.theta } shots: 1024
- returns: { prob: prob_bits_0, hist: hist_bits_0 }
- on_done: STEP_DONE
```

Both forms parse to the same `InvokeDef`.

- `input:` (existing) maps `child_param -> ctx.field`.
- `returns:` (new) maps `parent_field -> child_return`. For a shot-batched
  quantum child, the RHS may be a synthesized aggregate (`prob_bits_0`,
  `hist_bits_0`, `var_bits_0`) — the **same names q-orca synthesizes**.
- `shots:` (new) is the execution-mode flag; permitted only for a
  measurement-bearing (quantum/foreign) child, forbidden for a classical child
  (verifier error, mirroring q-orca's `SHOTS_ON_CLASSICAL_CHILD`).

AST: `InvokeDef` gains `returns?: Record<string,string>` and `shots?: number`.

### 3. Bridge implementation (the q-orca protocol)

Implement orca's side of the three JSON envelopes from the q-orca spec:

- **Machine descriptor** — emit `{name, params, returns, measurement_bearing}`
  for any orca machine (from its context + the new `## returns`).
- **Invocation envelope** — when an invoke's child is *foreign* (resolves to a
  `.q.orca.md` machine rather than a sibling `# machine` block), build
  `{child, args, shots, return_bindings}` and dispatch by running
  `q-orca run --json` over a process boundary.
- **Result envelope** — parse `{final_state, returns}` from the child's stdout
  and bind `returns` (including aggregates) into the parent context per the
  `returns:` mapping.

Symmetrically, orca's own runner exposes a `run --json` inbound entry point so a
q-orca parent can invoke an orca child through the same protocol.

#### `measurement_bearing` determination

The descriptor's `measurement_bearing` flag is a property of the **child**, not
the call site, and is derived from the child's definition — **not** from whether
any invoke passes `shots:`. A machine is measurement-bearing iff it contains a
measurement effect (a `measure(...)`-style action). q-orca decides this exactly
this way today (any action with a measurement / mid-circuit-measure effect); orca
machines are classical and report `false`. The flag is what lets the verifier
reject `shots:` on a classical child.

#### Protocol versioning

Every envelope carries a `protocol_version` field. The q-orca spec owns the
canonical value; orca duplicates the constant and a conformance test pins both
sides against the same fixture envelopes. A version the receiver does not support
is a hard, surfaced error — never a silent misread.

#### Error-handling contract

The result envelope distinguishes two failure modes, which map to orca's existing
`on_error` handling:

- **Child machine error** — the child ran but reached an error/failure final
  state (or its runner reported a domain error). The result envelope carries an
  `error` field with a structured code/message; the parent emits its `on_error`
  event.
- **Bridge/transport error** — the foreign runner could not be invoked, timed
  out, returned non-JSON, or returned an unsupported `protocol_version`. This is
  raised as a bridge error distinct from a child error; if the invoke declares
  `on_error`, the parent emits it with a `bridge`-category code so the author can
  tell "the child rejected my input" from "the bridge itself failed."

#### Safety

Dispatching a foreign child shells out to `q-orca run`. The bridge SHALL: pass
the invocation envelope over a pipe (never interpolate values into a shell
string), validate every `arg` value against the child descriptor's parameter
types before dispatch, and resolve the foreign machine path only within the
project's import roots (no absolute paths — consistent with q-orca's import
rules). A future training-loop use with untrusted machines would add an execution
timeout and an opt-in allowlist of runnable tools; both slot behind the same
dispatch boundary.

---

## Design Decisions

### Decision 1: Keep the bullet syntax; enrich it

Orca's `- invoke:` / `- on_done:` bullet form stays; `- returns:` and `shots:`
are additive. We do **not** adopt q-orca's `[invoke: Child(args) shots=N]`
heading-annotation surface — each tool keeps its own ergonomics and maps to the
neutral bridge envelopes. *Alternative considered:* converge on q-orca's
annotation syntax. Rejected — needless churn for orca authors and existing
machines; the envelope, not the surface, is the contract.

### Decision 2: Foreign children resolved by file extension

A child referencing a `.q.orca.md` file (via the deferred import mechanism, or
an explicit `tool: q-orca` marker) is foreign and routed through the bridge;
a sibling `# machine` block resolves natively as today. *Alternative:* an
explicit per-invoke `tool:` field always. Kept available as an override.

### Decision 3: Process + JSON transport

The bridge shells out to `q-orca run --json` per foreign invoke; no daemon, no
FFI (matches the q-orca design). Acceptable for the orchestration/debug
workloads this targets; a persistent transport can slot behind the same
envelopes later.

---

## Backward Compatibility / Migration

Additive. No existing orca machine declares `## returns`, `- returns:`, or
`shots:`; all continue to use implicit `{ finalState, context }` returns and
same-tool invokes. The bridge path activates only for foreign children.

---

## Test Cases

1. **Typed returns parse** — a machine with `## returns` parses to `ReturnDef[]`;
   absent section yields the current behavior.
2. **Return binding type-check** — `- returns: { done: converged }` verifies the
   parent field and child return types unify; mismatch is a verify error.
3. **Shots on classical child rejected** — `shots:` on a non-measurement child is
   a verifier error.
4. **Envelope round-trip** — descriptor / invocation / result envelopes
   round-trip against the shared fixtures from the q-orca conformance test.
5. **Hybrid execution** — an orca trainer invokes a q-orca forward-pass child via
   the bridge; the child's `prob_bits_0` aggregate flows into the trainer's
   context. (Pairs with q-orca's worked example.)

---

## Worked Example: Hybrid Trainer + Quantum Forward Pass

A classical orca trainer drives a q-orca quantum forward pass and reads back the
measured-bit expectation:

```md
# machine Trainer

## context
| Field | Type  |
|-------|-------|
| theta | float |
| prob  | float |

## returns
| Name | Type  |
|------|-------|
| prob | float |

## state step [initial]
> One training step: run the quantum forward pass, read the expectation.
- invoke: QForward input: { theta: ctx.theta } shots: 1024 returns: { prob: prob_bits_0 }
- on_done: STEPPED

## state stepped [final]

## transitions
| Source | Event   | Target  |
|--------|---------|---------|
| step   | STEPPED | stepped |
```

`QForward` is a q-orca machine (`forward.q.orca.md`) declaring
`bits[0]: bit` with `expectation` statistics. The bridge runs it at 1024 shots
and binds the synthesized `prob_bits_0` into the trainer's `prob`. (The q-orca
side is the `composed_predictive_coder` fixture, which already runs in-tool via
`q-orca run`.)

## Multi-Runtime Adoption

Orca ships four runtimes (`runtime-python`, `runtime-ts`, `runtime-go`,
`runtime-rust`). The bridge is **runtime-agnostic by construction**: the entire
contract is three JSON envelopes (descriptor / invocation / result) plus a
`protocol_version` constant, carried over a **process boundary** — no shared AST,
no FFI, no language-specific types. Every language can serialize JSON and spawn a
subprocess, so any runtime can implement it; the protocol is not even
orca-specific (any tool that speaks the envelopes can join).

**What a runtime needs** (the same shape everywhere — mirroring `runtime-python`):

1. **Parser** — recognize `## returns` and the invoke `returns:` / `shots:`
   modifiers (each runtime has its own parser).
2. **Envelopes** — serialize/deserialize the three shapes + a `protocol_version`
   check (`encoding/json`, `serde_json`, `JSON.parse`, …).
3. **`dispatch_foreign`** — spawn the child runner, pipe the invocation envelope
   to stdin, read the result envelope from stdout (`os/exec`, `std::process`,
   `child_process`).
4. **One dispatch hook** — a foreign-runner registry consulted where the invoke
   target is not a local sibling (in `runtime-python` this is the
   `start_child_machine` foreign branch; every runtime has the equivalent).

**Direction asymmetry.** *Outbound* (a runtime as the classical orchestrator
invoking a quantum child) is cheap and clean in any language — and is the
motivating case; the foreign child is essentially always a **q-orca (Python)**
process via `q-orca run --bridge`, since q-orca is the only quantum side.
*Inbound* (a runtime serving as the invoked child) is symmetric at the protocol
level, but orca machines are **reactive/event-driven**, so "run to completion as
a child" needs a per-runtime auto-driver — a real work item independent of
language. (`runtime-python` therefore scopes its first cut to outbound.)

**Why do it in more than one runtime.** The contract is identical, so a **shared
conformance suite** — every runtime checked against the *same* fixture envelopes
and the same `1.0` constant — is what keeps four independent implementations from
silently drifting. Each runtime then gives its own users (Go/Rust/TS
orchestrators) the same hybrid classical↔quantum capability.

**When it's worth it.** For parity, or a specific deployment (a Go service
dispatching quantum jobs; the Rust runtime's C/Fortran FFI callers reaching a
quantum child transitively). It may *not* be urgent where the real demand is "an
ML/training loop drives a quantum forward pass" — Python is the natural
orchestration language there, so `runtime-python` likely covers most actual
usage, and the others are completeness rather than need-driven until a concrete
consumer appears.

## Open Questions

1. **How does the verifier know a local `.q.orca.md` child is
   measurement-bearing?** It asks the bridge for the child's **machine
   descriptor** (which carries `measurement_bearing` and the typed returns)
   before checking the invoke — i.e. resolution emits the descriptor first, then
   arg/return/shots typing runs against it. The descriptor is cheap (parse +
   introspect; no execution).
2. **Bidirectional rich returns (q-orca invoking orca, getting typed returns)?**
   In scope by symmetry: the same three envelopes work both directions, and orca
   exposing `run --json` is the inbound half. The *worked* example here is
   orca→q-orca; the reverse direction is exercised by the same conformance
   fixtures and needs no additional protocol — just orca's `run --json` endpoint.

## Dependencies / Cross-References

- **q-orca bridge protocol** (in-flight OpenSpec change):
  `q-orca-lang/openspec/changes/add-cross-tool-bridge-protocol/specs/bridge-protocol/spec.md`
  — defines the three envelopes (descriptor / invocation / result) and the
  handoff this document implements on orca's side.
- **Sequenced after** orca's existing machine invocation
  (`docs/machine-invocation-design.md`, shipped) and q-orca's
  `add-parameterized-invoke` / `add-composed-runtime` (shipped).
- **Companion** to the q-orca side; the two should land together so the protocol
  has both endpoints.
