## Why

Orca today covers two artifact shapes: state machines (`# machine`)
and decision tables (`# decision_table`). The sibling q-orca dialect
covers quantum primitives. The sm-sae benchmark
(github.com/jascal/sm-sae) wants Orca-shaped artifacts for a wider
range of SAE compression and extraction techniques than the
quantum-encoding-only path polygram currently emits. Two concrete
gaps:

1. **Neural / distilled-transformer artifacts** (e.g. sae-forge's
   `NativeModel`, concept-bottleneck networks). A typed DAG of
   layer operations with weights stored in sidecar binaries.
   Polygram emits these as bespoke files outside Orca's grammar
   today; the benchmark wants them inside `.orca.md` so they share
   the parser, verifier, and tooling pipeline.

2. **Sparse / cluster-aware feature dictionaries** (e.g.
   hierarchical SAEs, group-sparse codes). A cluster manifest plus
   sparse weight references. Same story — currently expressed in
   adjacent JSON sidecars; the benchmark wants the cluster
   structure inside the orca artifact so that
   `cluster_completeness`, `sparsity_bound`, and decoder-norm
   preservation can be machine-checked alongside the rest of the
   workflow.

The instinct to spawn `n-orca` and `s-orca` as separate dialects
is wrong on inspection. q-orca's dialect status is justified
because qubits, unitary gates, and measurement outcomes are a
genuinely different data model — a qubit cannot type-unify with a
classical scalar, a unitary cannot type-unify with a tensor op,
and measurement statistics need their own vocabulary. Neural and
sparse artifacts, in contrast, share the classical data model:
they are typed DAGs over tensor-valued context. What they need is
new **types** (tensors, weight references, sparse matrices) and
new **sections** (weights, cluster manifests, faithfulness
assertions), not a parallel grammar.

The right framing is therefore: one coherent grammar extension to
`orca-lang` that closes both gaps, with `# machine` and
`# decision_table` keeping their current semantics and q-orca
remaining a separate dialect. Splitting neural and sparse into two
changes would duplicate the type-system work (`tensor<...>`,
`weight_ref<...>`, `sparse_matrix<...>` are shared) and force
hybrid artifacts (transformer with a sparse output head) to span
two parallel grammars.

This is planning-only. No code in this PR — the deliverable is
proposal + design + delta specs + tasks + three worked examples.

## What Changes

- **Language — types**: introduce three new type-system primitives
  usable anywhere a type appears (context, weights table, return
  types, decision-table action types):
  - `tensor<dtype, shape>` — tensor with declared shape; shape may
    include named symbolic dimensions for shape unification across
    operations.
  - `weight_ref<path, sha256, key>` — content-addressed reference
    to a tensor stored in a sibling binary (typically
    `*.safetensors`). The grammar SHALL forbid inlining tensor
    values in the markdown — references are the only supported
    mechanism.
  - `sparse_matrix<dtype, shape, format>` — sparse tensor with
    `format ∈ {COO, CSR}`.
- **Language — sections**: four new top-level section types,
  legal alongside existing ones in a `# machine` or as standalone
  blocks in artifacts that contain only weights/clusters/faithfulness:
  - `## weights` — declares external weights this artifact
    references. Table form: `| name | type | weight_ref | trainable? |`.
  - `## cluster_manifest` — named clusters with per-cluster
    feature ID lists. Table form: `| cluster | features | size |`.
  - `## faithfulness` — declarative assertions like `faithfulness
    >= 0.95 under distribution D against reference R`.
  - `## provenance` — extraction-technique ID, version, config
    hash, source-SAE hash, optional benchmark scores. Required on
    any artifact emitted by an extraction technique.
- **Language — invariants**: six new invariant kinds in
  `## verification rules` that the verifier can evaluate
  statically (parameter counts, shapes, cluster coverage, sparsity
  bound, decoder-norm preservation declarations, faithfulness
  declarations).
- **Language — extension to existing `## transitions` semantics**:
  no new construct, but the types above are legal in transition
  context/action signatures. A neural module expresses itself as a
  `# machine` whose states are activation tensors (typed via
  `tensor<...>`) and whose transitions are layer operations
  (referencing weights via `weight_ref`).
- **AST**: new `TensorType`, `WeightRefType`, `SparseMatrixType`
  type nodes; new `WeightDef`, `ClusterDef`, `ClusterManifestDef`,
  `FaithfulnessDef`, `ProvenanceDef` section nodes; new
  invariant-kind enum values on the existing verification-rules
  AST.
- **Parser**: extend the type grammar to recognize the three new
  type forms; extend section dispatch in the markdown parser to
  handle the four new sections; recognize the new invariant-kind
  keywords in `## verification rules`.
- **Verifier**: new shape-and-weights stage that runs after the
  existing structural / completeness / determinism stages. Checks
  the six new invariant kinds plus weight-reference integrity
  (hashes match if the binary is present; absent binaries
  surface a `WEIGHT_BINARY_MISSING` warning, not an error, since
  artifacts are often handed around without their binaries).
- **Compiler**: out of scope. The XState/Mermaid backends already
  ignore unknown context types; they SHALL continue to do so for
  artifacts that use the new types, which keeps existing pipelines
  passing through unaltered.
- **Examples**: three worked examples live under the change's
  `examples/` directory and become canonical fixtures once
  implementation lands:
  1. A tiny GPT-2-class transformer (~10K params) expressed as a
     `# machine` with `## weights`, tensor-typed states, and
     `faithfulness` / `parameter_count` invariants.
  2. A 16-feature group-sparse SAE expressed with
     `## cluster_manifest`, `## weights` (sparse decoder), and
     `cluster_completeness` / `sparsity_bound` invariants — no
     transitions needed.
  3. A hybrid: small transformer with a sparse output head,
     showing `## transitions` + `## cluster_manifest` in one file.

## Capabilities

### New Capabilities
None. This is a language/AST/verifier extension on existing
capabilities. No new file extension; no new top-level document
kind beyond what `# machine` and `# decision_table` already
provide (artifacts that contain only `## weights` +
`## cluster_manifest` + `## faithfulness` are valid standalone
documents under the same `.orca.md` extension, with no `# machine`
heading required).

### Modified Capabilities

- **`language`**: extended type grammar (three new type forms),
  four new sections, six new invariant-kind keywords, one new
  document-shape rule (sections-only artifact).
- **`verifier`**: new shape-and-weights stage plus six new
  invariant-kind checks; new error/warning codes
  (`SHAPE_MISMATCH`, `WEIGHT_HASH_MISMATCH`,
  `WEIGHT_BINARY_MISSING`, `WEIGHT_KEY_MISSING`,
  `CLUSTER_FEATURE_DUPLICATE`, `CLUSTER_COVERAGE_GAP`,
  `SPARSITY_BOUND_VIOLATION`, `DECODER_NORM_DRIFT`,
  `PARAMETER_COUNT_MISMATCH`, `FAITHFULNESS_TEST_SCAFFOLD_REQUIRED`,
  `INLINE_TENSOR_FORBIDDEN`, `PROVENANCE_REQUIRED`).
- **`compiler`**: no new requirement. The change adds a
  passthrough note: existing backends SHALL continue to ignore
  unknown sections, preserving regression-safety for consumers
  that don't yet understand the new sections.

## Impact

- `packages/orca-lang/src/parser/ast.ts` — add `TensorType`,
  `WeightRefType`, `SparseMatrixType`, `WeightDef`, `ClusterDef`,
  `ClusterManifestDef`, `FaithfulnessDef`, `ProvenanceDef`; extend
  `InvariantKind` enum. ~120 LOC.
- `packages/orca-lang/src/parser/markdown-parser.ts` — type
  grammar extension, four new section parsers, new invariant-kind
  recognition. ~250 LOC + tests.
- `packages/orca-lang/src/verifier/shape-and-weights.ts` — new
  verifier stage. ~350 LOC + tests.
- `packages/orca-lang/src/verifier/index.ts` — wire the new stage
  into the pipeline after determinism, before properties checking.
  ~10 LOC.
- `packages/orca-lang/docs/orca-md-grammar-spec.md` — document
  the new type forms, sections, invariants in the canonical
  grammar reference.
- `packages/orca-lang/examples/neural-tiny-transformer.orca.md`,
  `packages/orca-lang/examples/sparse-sae-16f.orca.md`,
  `packages/orca-lang/examples/hybrid-transformer-sparse-head.orca.md`
  — three worked examples (drafts ship with this change in
  `openspec/changes/extend-orca-lang-neural-and-sparse/examples/`;
  promoted to package examples on implementation).
- `packages/orca-lang/tests/` — round-trip parse + verify on the
  three examples; regression test confirming existing
  `*.orca.md` and `*.q.orca.md` artifacts parse identically.
- `docs/error-catalog.md` — entries for the twelve new
  error/warning codes.
- **No new runtime dependencies.** Runtime support (loading
  weights, evaluating tensor ops, running faithfulness checks)
  ships as a separate follow-up change. This spec defines only
  the static grammar + verification surface.

## Scope boundary

In scope:
- Type grammar for `tensor<...>`, `weight_ref<...>`,
  `sparse_matrix<...>`.
- Sections: `## weights`, `## cluster_manifest`,
  `## faithfulness`, `## provenance`.
- Invariant kinds: `shape_consistency`, `sparsity_bound`,
  `cluster_completeness`, `decoder_norm_preservation`,
  `parameter_count`, `faithfulness`.
- Verifier-stage error and warning codes for each.
- AST + parser + static verifier behavior.
- Three worked examples (parse + verify, no implementation).
- Capability-negotiation note for downstream consumers.

Explicitly **out of scope**:
- **Implementation.** This is a spec-only change.
- **Inlining weights into markdown.** Forbidden by design; the
  spec explicitly rejects this as a non-goal and the verifier
  emits `INLINE_TENSOR_FORBIDDEN` if encountered.
- **Compile back-ends / hardware targeting.** A separate change
  (`add-neural-compile-targets`) will own emitting PyTorch /
  ONNX / TFLite / safetensors-loading runtime glue.
- **Schema versioning.** A separate change
  (`add-orca-schema-version`) will own version negotiation; this
  change depends on it for the capability-negotiation flow but
  does not itself introduce a schema field.
- **Algebraic / probabilistic / circuit extensions.** The
  speculative `a-orca` / `p-orca` / `c-orca` family is out of
  scope. The same logic applies — they are probably extensions,
  not dialects — but each is its own future change.
- **q-orca convergence.** q-orca remains a separate dialect.
  Its data model (qubits, unitaries, measurements) does not
  type-unify with classical tensors; this change does not
  attempt to merge them.
- **Runtime weight loading.** No runtime in this change. The
  verifier validates hashes only when the binary is present in
  the artifact directory; otherwise it emits a warning, not an
  error.

## Dependencies and follow-ups

- **Depends on (soft)**: `add-orca-schema-version`. Capability
  negotiation requires a version field. The spec lands without
  it (consumers that load `.orca.md` and ignore unknown sections
  continue to work; consumers that opt into the new sections do
  so by capability advertisement). Versioning can land in parallel
  and tighten the negotiation contract later.
- **Parked follow-ups (NOT this change)**:
  - `add-neural-compile-targets` — PyTorch / ONNX / TFLite /
    safetensors-loading runtime; weight binary lifecycle.
  - `add-orca-schema-version` — version field + capability
    advertisement; cross-cuts this change and others.
  - `add-runtime-faithfulness-harness` — the actual numerical
    check that a referenced reference model meets the declared
    faithfulness threshold. The spec here describes only the
    declarative form and the test-scaffold generation.
  - `extend-orca-algebraic` (speculative `a-orca`),
    `extend-orca-probabilistic` (`p-orca`),
    `extend-orca-circuit` (`c-orca`) — each its own future
    change once a concrete consumer surfaces.
