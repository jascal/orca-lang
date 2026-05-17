## Context

Orca's grammar today is shaped by two artifact kinds:

- `# machine` — state machines with `## context`, `## events`,
  `## state ...`, `## transitions`, `## guards`, `## actions`,
  optional `## effects`, optional `## properties`, optional
  `## verification rules`. Types are primitive scalars (`string`,
  `int`, `decimal`, `bool`) with optional/array modifiers, plus
  array (`Field[]`) and optional (`string?`).
- `# decision_table` — typed condition/action grids with
  `## conditions`, `## actions`, `## rules`, with numeric range
  conditions (`int_range`, `decimal_range`) added via the
  decision-tables-spec rollout.

q-orca is a separate dialect. Its file extension is `.q.orca.md`;
its data model centers on qubits (`bit`, `qubit`), unitary
operators, and measurement outcomes. It has its own AST, parser,
verifier pipeline, and compile backends. The decision to keep
q-orca separate is sound: a qubit cannot type-unify with a
classical scalar, the operations are not composable with classical
transitions, and the verifier needs entanglement / unitarity /
superposition-leak checks that have no analog in the classical
world.

The sm-sae benchmark wants Orca-shaped artifacts for SAE
compression and extraction techniques beyond the
quantum-encoding-only path that polygram currently emits.
Specifically:

1. Neural artifacts — sae-forge's `NativeModel`,
   concept-bottleneck networks, distilled-transformer carriers.
   These are typed DAGs of layer ops with weights in sidecar
   `*.safetensors` files.
2. Sparse artifacts — hierarchical SAEs, group-sparse codes.
   These are cluster manifests plus sparse weight references.

Both gaps share three features:
- **Classical data model.** Tensors are not qubits; layer ops
  are not unitaries. A tensor type-unifies cleanly with the
  existing primitive scalars (it just has rank and shape).
- **Sidecar binary references.** Weights live in `*.safetensors`,
  not in the markdown. Both gaps need the same `weight_ref`
  primitive.
- **Static invariants checkable without execution.** Shape
  consistency, parameter counts, cluster completeness, sparsity
  bounds — all are structural checks the verifier can run
  without loading the binaries.

The natural design instinct ("spin up `n-orca` and `s-orca` as
sister dialects to q-orca") is wrong on inspection. Dialect status
costs a full duplicate stack: parser, AST, verifier, compilers,
docs, examples, MCP tools. The cost is only worth paying when the
data model truly diverges. Here it does not — the divergence is
in *what the artifact represents*, not in the underlying types.
What's actually needed is new types and new sections inside the
existing grammar.

## Goals / Non-Goals

**Goals:**

- One extension to `orca-lang`'s grammar and type system that
  covers neural and sparse artifacts.
- Existing `*.orca.md` and `*.q.orca.md` artifacts SHALL parse
  identically — zero regression.
- The three worked examples SHALL parse, verify, and round-trip
  through the AST without loss.
- Each new invariant kind has a specified failure message and
  error code, listed in `docs/error-catalog.md`.
- Verifier behavior is well-defined when binaries are absent
  (warning, not error), so artifacts travel without their weights.
- Capability negotiation path so consumers that don't understand
  the new sections continue to work.
- No changes to existing `# machine` or `# decision_table`
  semantics.
- q-orca remains a separate dialect; this change does not modify
  q-orca's grammar.

**Non-Goals:**

- No implementation. Spec-only deliverable.
- No inlining of tensor values in markdown. References are the
  only supported mechanism; the parser SHALL reject inline tensor
  literals with `INLINE_TENSOR_FORBIDDEN`.
- No compile back-ends or hardware targeting. Lives in
  `add-neural-compile-targets`.
- No schema-versioning mechanism. Lives in
  `add-orca-schema-version`; this change relies on its capability
  advertisement once it lands.
- No runtime faithfulness check. The `## faithfulness` section is
  *declarative*; running the test ships in
  `add-runtime-faithfulness-harness`.
- No q-orca convergence. The neural/sparse extensions live
  entirely in the classical dialect.
- No algebraic / probabilistic / circuit extensions. Each is its
  own future change.

## Decisions

### D1. Extension, not new dialect

**Decision:** Add types and sections to `orca-lang`. Do not
spawn `n-orca` or `s-orca`.

**Rationale:**

q-orca's separation is justified by data-model divergence:
qubits, unitaries, and measurement outcomes have no classical
analog. Neural and sparse artifacts share the classical data
model — tensors are just typed multi-dimensional arrays; layer
ops are pure functions; cluster manifests are partitions over
feature IDs. Spinning two new dialects would duplicate the
parser, AST, verifier pipeline, and tooling, and would make
hybrid artifacts (a transformer with a sparse output head)
require two parallel grammars in one workflow.

Cross-references:

- q-orca's dialect rationale lives in
  `/Users/allans/code/q-orca-lang/openspec/specs/language/spec.md`
  (the broader q-orca language spec) and is summarized in the
  q-orca README under the heading "Why a separate dialect."
- Q-orca composition syntax (e.g.
  `add-parameterized-invoke`) is built specifically because
  q-orca's data model could not be merged into classical orca.
  The same argument does not hold for tensors: a `tensor<float,
  [N, D]>` field in a `## context` table behaves grammatically
  identically to any other typed context field.

**Alternatives considered:**

- *Spin up `n-orca`.* Rejected — see above; duplicates the
  pipeline for no data-model gain. A hybrid transformer +
  sparse-head artifact would also need a third dialect or live
  in two files glued by external tooling.
- *Spin up `s-orca`.* Same rejection.
- *Embed neural/sparse as a child-machine subtype invoked from
  classical orca.* Rejected — the artifact is not a state
  machine; forcing it into the machine grammar adds rote
  states (`loaded → forward → done`) that obscure what the
  artifact actually declares.

### D2. Three new type-system primitives

**Decision:** Add `tensor<dtype, shape>`,
`weight_ref<path, sha256, key>`, and
`sparse_matrix<dtype, shape, format>` to the type grammar.
These are legal wherever a type appears (context table, weights
table, decision-table action types, future return types).

**Grammar:**

```
tensor<dtype, shape>
  dtype ::= f16 | bf16 | f32 | f64 | i8 | i16 | i32 | i64 | u8 | bool
  shape ::= "[" dim ("," dim)* "]"
  dim   ::= integer | identifier        // identifier = named symbolic dim

weight_ref<path, sha256, key>
  path   ::= string-literal               // relative to artifact directory
  sha256 ::= hex64                        // 64-character hex digest
  key    ::= string-literal               // tensor name inside the binary

sparse_matrix<dtype, shape, format>
  dtype  ::= as above
  shape  ::= as above
  format ::= COO | CSR
```

Named symbolic dimensions (e.g.
`tensor<f32, [batch, seq, hidden]>`) unify across operations
within an artifact — a transition consuming
`tensor<f32, [batch, seq, hidden]>` and producing
`tensor<f32, [batch, seq, hidden]>` declares that the operation
preserves these dimensions. Concrete integers and named dims may
mix: `tensor<f32, [batch, 768]>`.

**Rationale:**

- Tensor types must carry shape because shape consistency is the
  primary static check; without it the verifier can only check
  dtype, which is too weak to be useful.
- Symbolic dimensions are necessary to express
  shape-preservation invariants that hold across arbitrary
  batch / sequence sizes — concrete-only shapes would force the
  artifact to commit to one set of dimensions.
- `weight_ref` is content-addressed because the same artifact
  may be loaded from different storage locations (local, S3,
  HF) and the hash is the integrity anchor, not the path.
- `sparse_matrix` carries format because the verifier needs to
  evaluate `sparsity_bound` against the actual nnz, and the
  binary loader needs format to decode the safetensor; bundling
  these in the type avoids a parallel format-declaration
  section.

**Alternatives considered:**

- *Single `tensor<dtype, shape, location?>` type with optional
  storage location.* Rejected — overloads tensor with two roles
  (computed activation vs. stored parameter); the
  trainable-flag, hash, and lifecycle of a stored weight are
  distinct enough to deserve their own type.
- *Implicit shape (just `tensor<f32>`).* Rejected — kills the
  `shape_consistency` invariant.
- *Format as a context field, not part of the type.* Rejected —
  the format determines the binary layout; coupling it to the
  type is the safest place.

### D3. Four new sections

**Decision:** Add `## weights`, `## cluster_manifest`,
`## faithfulness`, `## provenance` as peers to the existing
sections.

**Table forms:**

```markdown
## weights

| name | type | weight_ref | trainable? |
|------|------|------------|------------|

## cluster_manifest

| cluster | features | size |
|---------|----------|------|

## faithfulness

| metric | threshold | distribution | reference |
|--------|-----------|--------------|-----------|

## provenance

| field | value |
|-------|-------|
| extraction_technique | sae_forge_v1 |
| version              | 0.4.2 |
| config_hash          | sha256:... |
| source_sae_hash      | sha256:... |
| benchmark_score      | 0.972 |
```

**Rationale:**

- `## weights` is a flat table rather than embedded in
  `## context` because weight rows have multiple metadata fields
  (type, ref, trainability) that don't fit a single "Type"
  column.
- `## cluster_manifest` is a table rather than nested YAML
  because the existing parser is table-based and round-trips
  cleanly; a YAML blob would force a second parsing layer.
- `## faithfulness` is declarative rather than executable
  because spec-only — the actual numerical check runs at
  build/run time. The verifier produces test scaffolding from
  the declaration.
- `## provenance` is a key/value table because the field set
  varies by extraction technique (some have benchmark scores,
  some don't); a fixed table would be over-prescriptive.
  Front-matter was considered but rejected — Orca files do not
  use YAML front-matter today, and adding it here would create
  a parsing surface that competes with the existing markdown
  conventions.

**Alternatives considered:**

- *Folding weights into `## context`.* Rejected — context
  fields are part of the machine's mutable state; weights are
  fixed references. Mixing them blurs which fields are
  trainable and which are activations.
- *Putting provenance in YAML front-matter.* Rejected — see
  above. The repo's parser is markdown-section-based;
  introducing YAML front-matter creates a parallel surface.

### D4. Six new invariant kinds

**Decision:** Extend `## verification rules` with the kinds in
the table below. The existing parser already accepts a bullet
list under `## verification rules`; the keys are added to the
invariant-kind enum and parsed by name with optional parameters.

```markdown
## verification rules

- shape_consistency
- sparsity_bound: 8
- cluster_completeness
- decoder_norm_preservation: tolerance=0.01, reference=W_dec_baseline
- parameter_count: 10_240
- faithfulness: kl_divergence <= 0.05 under distribution=imagenet_val against reference=teacher_model
```

| Kind | Parameters | Verifier action |
|------|------------|-----------------|
| `shape_consistency` | none | For every transition action whose signature involves tensor types, the declared output shape SHALL match each consumer's expected input shape. Symbolic dims unify by name; concrete dims unify by value. |
| `sparsity_bound: <max_nnz_per_row>` | int | For every `sparse_matrix` weight, the declared or referenced nnz-per-row SHALL be ≤ `<max_nnz_per_row>`. |
| `cluster_completeness` | none | Every feature ID in the relevant tensor SHALL appear in exactly one cluster in `## cluster_manifest`. |
| `decoder_norm_preservation: tolerance=<t>, reference=<R>` | decimal, name | Declares that decoder column norms equal `<R>`'s norms within `<t>`. Verifier emits test scaffolding; numerical check runs at compile/run time. |
| `parameter_count: <expected>` | int | Sum of element counts across all `## weights` rows (using each row's declared shape) SHALL equal `<expected>`. |
| `faithfulness: <metric>, <threshold>, <distribution>, <reference>` | identifier, decimal, identifier, identifier | Same kind as the `## faithfulness` section row; allowed inline so machines that don't need a full section can declare a single faithfulness rule. The verifier emits test scaffolding only. |

**Rationale:**

- `shape_consistency` is the headline check that justifies the
  whole shape-bearing tensor type.
- `sparsity_bound` is a pure structural check the verifier can
  run from declarations alone — no binary needed.
- `cluster_completeness` is what polygram currently
  hand-validates; promoting it to a first-class invariant means
  the benchmark loses one bespoke validator.
- `decoder_norm_preservation` is declarative because the actual
  norm check requires loading the binary. The verifier asserts
  the *intent* and produces the scaffolding.
- `parameter_count` catches a class of bugs where the weights
  table drifts from the artifact's headline parameter count.
- `faithfulness` is the formal declaration of the contract that
  motivated the entire neural artifact pipeline.

**Alternatives considered:**

- *Embed shape checks implicitly in transition typing without
  an opt-in keyword.* Rejected — would break existing machines
  that have informal/loose context typing. Opt-in keeps the
  change backwards-compatible.
- *Make `faithfulness` strictly a section, not also an inline
  kind.* Rejected — single-rule artifacts shouldn't be forced
  to spin up a whole section.

### D5. Neural module = `# machine` with tensor-typed states

**Decision:** A neural module is a `# machine` whose states are
named activation tensors (typed via `tensor<...>` in `## context`)
and whose transitions are layer operations referencing weights
via `weight_ref` action signatures. No new top-level construct.

**Rationale:**

The existing transition table is a typed DAG of operations —
that's exactly what a layer-by-layer neural module is. Forcing a
parallel construct would mean two ways to express the same
shape. Letting the existing grammar do the work means tensor
shapes flow through the verifier's existing transition-typing
machinery; we only add the type primitives.

A neural module typically has:
- One `[initial]` state representing the input activation.
- One `[final]` state representing the output activation.
- No `## events` (or a single `forward` event), because the
  forward pass is linear, not event-driven.
- No `## guards`, because there's no branching in a feedforward
  module. (Branching neural modules — mixtures-of-experts, etc.
  — *use* guards; this is an extra-credit shape, not a
  required pattern.)

This means a neural artifact does sometimes have a degenerate
state machine (linear chain, no events). That's acceptable. The
alternative — introducing a separate top-level construct for
neural DAGs — would split the language and force tooling to
handle two parallel artifact kinds.

### D6. Standalone artifacts (sections-only documents)

**Decision:** An `.orca.md` document MAY contain only the new
sections (`## weights`, `## cluster_manifest`, `## faithfulness`,
`## provenance`) with no `# machine` heading. The parser SHALL
treat this as a valid document whose AST is a
`SectionsOnlyArtifact` node.

**Rationale:**

A group-sparse SAE doesn't need transitions — it's a static
dictionary of features. Forcing a stub `# machine` heading
would be busywork that adds confusion ("what does this machine
*do*?"). The sections-only artifact is a clear, minimal shape
for dictionary-style artifacts.

Round-trip rule: a sections-only artifact must contain at least
one of `## weights`, `## cluster_manifest`, or `## provenance`.
A document with only `## faithfulness` (and nothing else) is a
parse error — `EMPTY_ARTIFACT` — because faithfulness is a
contract *about* an artifact, not the artifact itself.

### D7. Verifier behavior when binaries are absent

**Decision:** If a `weight_ref`'s target binary is not present
in the artifact directory, the verifier emits
`WEIGHT_BINARY_MISSING` at **warning** severity, not error.
Hashes are checked only when the binary is present; mismatches
are `WEIGHT_HASH_MISMATCH` at error severity. Missing keys
inside a present binary are `WEIGHT_KEY_MISSING` at error
severity.

**Rationale:**

Artifacts are routinely passed around without their weight
binaries — for review, for static analysis, for diagrams. A
hard error in that case would make the verifier unusable for the
common review case. The contract is: if the binary is *there*,
its integrity is checked rigorously; if it's not, the absence is
reported but the artifact remains valid for static analysis.

### D8. Capability negotiation (soft dependency on schema version)

**Decision:** Consumers that load `.orca.md` and ignore unknown
sections continue to work. Consumers that want to use the new
sections opt in by declaring capability `neural-and-sparse-v1` at
load time. Until `add-orca-schema-version` lands, the convention
is documented but not enforced — consumers MAY assume default
support if they can parse the new sections, and SHOULD detect
unknown sections gracefully.

**Rationale:**

A versioning mechanism is a cross-cutting concern that deserves
its own change. The right hook here is to document the
capability name now so that
`add-orca-schema-version`'s capability advertisement has a
target string to use.

## Risks / Trade-offs

- **[Risk]** Adding tensor types to the type grammar may
  destabilize existing type-grammar users (decision tables,
  guards). → **Mitigation:** the new types are recognized only
  by token shape (`tensor<...>`, `weight_ref<...>`,
  `sparse_matrix<...>`); they don't overlap with existing
  primitive scalars or `Field[]` syntax. Existing machines have
  no `<>`-bracketed types and will parse identically.

- **[Risk]** `## weights` with hundreds of rows could blow up
  parse time and AST size. → **Mitigation:** weights are
  declared per *named* tensor, not per element. A 10K-param
  transformer typically has fewer than 20 weight rows; a large
  model has at most a few hundred. The parser is linear in row
  count; this is fine. If a future artifact has tens of
  thousands of weight rows, the right answer is a glob
  reference (out of scope), not optimizing the parser.

- **[Risk]** Symbolic-dim unification across transitions could
  surprise users when two ops use the same name for different
  meanings. → **Mitigation:** symbolic dims are scoped to a
  single machine; the verifier emits `SHAPE_NAME_REBINDING` if a
  name's bound value diverges between two transitions. (This is
  a sub-rule of `SHAPE_MISMATCH`.) Authors who want truly
  independent dims use distinct names.

- **[Risk]** `weight_ref` hashes are content-addressing the
  binary as a whole, not per-tensor. If two artifacts share a
  binary, both reference the same hash; if one's binary is
  modified, both artifacts see `WEIGHT_HASH_MISMATCH`. →
  **Mitigation:** by design, content-addressing means tampering
  surfaces immediately on both consumers. The alternative
  (per-tensor hashes) would require parsing safetensors to
  compute a hash per key, which costs us static-only
  checkability.

- **[Risk]** `## provenance` table fields are open-ended. Two
  extraction techniques could pick different field names for
  the same concept. → **Mitigation:** the spec defines a small
  required set (`extraction_technique`, `version`,
  `config_hash`, `source_sae_hash` when applicable) and lets
  techniques add their own fields below that. A registry of
  field names can land later if convergence becomes important.

- **[Trade-off]** Declarative `faithfulness` means the verifier
  can't actually check that the artifact meets its declared
  threshold — only that the declaration is well-formed. We
  accept this; the spec is the contract, and the runtime
  follow-up (`add-runtime-faithfulness-harness`) is what
  enforces it numerically. A test-scaffold output keeps the
  declaration from being purely decorative.

- **[Trade-off]** Allowing sections-only artifacts (no
  `# machine` heading) means consumers that hard-code "every
  `.orca.md` has at least one machine" will break. → We accept
  this; the same consumers already handle multi-machine files
  via `---` separators, and adding a sections-only document
  shape is a one-line check (`file.machines.length === 0 &&
  file.sections.length > 0`). The error message is clear.

- **[Trade-off]** The change is "one coherent grammar
  extension" rather than two smaller ones. A reviewer reading
  only the neural example might find the sparse types unfamiliar
  (and vice versa). → We accept this. The cost of splitting is
  higher: shared types would be duplicated, the hybrid
  transformer-with-sparse-head example would need to live in
  two changes, and the dependency ordering would force
  sequential rather than parallel review.

## Migration Plan

No migration. Existing `*.orca.md` and `*.q.orca.md` artifacts
SHALL parse identically — they declare none of the new types and
none of the new sections.

**Regression test (required, lives in
`packages/orca-lang/tests/test-regression-existing-corpus.ts`):**

Iterate over every `.orca.md` and `.q.orca.md` in
`packages/*/examples/` and `packages/*/orca/`. Parse with the
extended parser; the resulting AST SHALL be byte-identical to
the pre-extension AST under round-trip through
`ast-to-markdown`. If any file's AST changes, the test fails
and the extension has introduced an unintended grammar shift.

**Rollback:** revert the change's commits. Artifacts that use
the new types or sections will fail to parse — the expected
rollback signal.

## Open Questions

1. **Is `## provenance` already partially covered by some other
   convention?** Quick repo scan finds no front-matter handling
   in the markdown parser and no provenance section in the
   grammar spec. So provenance is genuinely new. **Confirmed:
   no conflict.** If reviewers find a hidden convention I
   missed, flag in PR review.

2. **Should `weight_ref` allow URI schemes (`s3://...`,
   `https://...`) or only relative paths?** Leaning relative
   paths only — the verifier checks for binary presence in the
   artifact directory; URIs would require a fetch step that
   pulls runtime concerns into a static-analysis layer.
   Resolver plug-ins can land in
   `add-neural-compile-targets`. Defer.

3. **Does the regression test need to cover artifacts produced
   by the demos at runtime, or only checked-in examples?**
   Leaning checked-in only. Runtime-produced artifacts aren't
   stable enough to anchor a regression test. Defer.

4. **How do symbolic dims interact with decision tables that
   produce tensor-typed outputs?** Not in scope for this
   change — DT action types are scalars today. If a future
   change introduces tensor-typed DT outputs, symbolic-dim
   unification rules carry over unchanged.

5. **Should `sparse_matrix` support BSR (block sparse row) in
   addition to COO/CSR?** Defer. Two formats cover sm-sae's
   current needs; BSR can be added as a non-breaking enum
   extension when an artifact demands it.

6. **Naming: should the change be `extend-orca-lang-neural`
   plus a follow-up `extend-orca-lang-sparse`?** Considered and
   rejected at proposal time — see "Why" in `proposal.md`. The
   type-system additions are shared, and the hybrid example
   demonstrates why they belong in one coherent change.

7. **Capability advertisement string.** Tentative name
   `neural-and-sparse-v1`. Coordinate with the schema-version
   change before final commitment.
