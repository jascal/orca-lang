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

### 2. Invoke return bindings + `shots:`

Extend `InvokeDef` with:

```md
## state training
- invoke: QForward input: { theta: ctx.theta } shots: 1024
- returns: { prob: prob_bits_0 }
- on_done: STEP_DONE
```

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

## Dependencies / Cross-References

- **q-orca bridge protocol**:
  `q-orca-lang/openspec/changes/add-cross-tool-bridge-protocol` — defines the
  envelopes and handoff this document implements on orca's side.
- **Sequenced after** orca's existing machine invocation
  (`docs/machine-invocation-design.md`, shipped) and q-orca's
  `add-parameterized-invoke` / `add-composed-runtime` (shipped).
- **Companion** to the q-orca side; the two should land together so the protocol
  has both endpoints.
