## 1. AST

- [ ] 1.1 Add `TensorType` node in
  `packages/orca-lang/src/parser/ast.ts` with fields
  `dtype: TensorDType`, `shape: Array<number | string>`
  (string entries = symbolic dim names).
- [ ] 1.2 Add `WeightRefType` node with fields
  `path: string`, `sha256: string` (64-char hex),
  `key: string`.
- [ ] 1.3 Add `SparseMatrixType` node with fields
  `dtype: TensorDType`, `shape: Array<number | string>`,
  `format: 'COO' | 'CSR'`.
- [ ] 1.4 Add `WeightDef` (one row of `## weights`),
  `ClusterDef` (one row of `## cluster_manifest`),
  `ClusterManifestDef` (the whole section), `FaithfulnessDef`
  (one row of `## faithfulness`), `ProvenanceDef` (whole
  key/value table).
- [ ] 1.5 Extend `InvariantKind` enum with
  `shape_consistency`, `sparsity_bound`,
  `cluster_completeness`, `decoder_norm_preservation`,
  `parameter_count`, `faithfulness`. Add parameter fields on
  `InvariantDef` for the kinds that take parameters.
- [ ] 1.6 Add `SectionsOnlyArtifact` node for documents that
  contain only `## weights` / `## cluster_manifest` /
  `## faithfulness` / `## provenance` with no `# machine`
  heading. Extend `OrcaFile` to hold a list of these alongside
  `machines` and `decisionTables`.

## 2. Parser

- [ ] 2.1 Extend the type-grammar tokenizer in
  `packages/orca-lang/src/parser/markdown-parser.ts` to
  recognize `tensor<...>`, `weight_ref<...>`,
  `sparse_matrix<...>`. Parse parameter lists inside `<...>`
  with comma separation; reject malformed shapes with
  structured errors.
- [ ] 2.2 Add section parser for `## weights` (table:
  `| name | type | weight_ref | trainable? |`). Wire into the
  section dispatch in the markdown parser. `trainable?` cell
  accepts `true` / `false` (default `false`).
- [ ] 2.3 Add section parser for `## cluster_manifest` (table:
  `| cluster | features | size |`). `features` cell is a
  comma-separated list of feature IDs (integers or
  identifiers); `size` is informational and SHALL match
  `features.length` (parser-level check —
  `CLUSTER_SIZE_MISMATCH` if not).
- [ ] 2.4 Add section parser for `## faithfulness` (table:
  `| metric | threshold | distribution | reference |`).
- [ ] 2.5 Add section parser for `## provenance` (key/value
  table with two columns `| field | value |`; arbitrary fields
  allowed, with required-set check moved to the verifier).
- [ ] 2.6 Extend `## verification rules` bullet parser to
  recognize the six new invariant kinds and their parameter
  syntax (see the grammar table in
  `specs/language/spec.md`).
- [ ] 2.7 Recognize a sections-only document: if no `# machine`
  or `# decision_table` heading appears but at least one new
  section does, build a `SectionsOnlyArtifact` instead of
  raising `MISSING_MACHINE`.
- [ ] 2.8 Forbid inline tensor literals. If the parser
  encounters anything that looks like a tensor literal (numeric
  array in a cell that is typed `tensor<...>`), emit
  `INLINE_TENSOR_FORBIDDEN`. References are the only supported
  mechanism.
- [ ] 2.9 Unit tests in
  `packages/orca-lang/tests/parser-neural-sparse.spec.ts`
  covering: each new type with valid and malformed inputs,
  each new section, the sections-only artifact shape, each new
  invariant-kind keyword, and `INLINE_TENSOR_FORBIDDEN`.

## 3. Verifier — shape-and-weights stage

- [ ] 3.1 Create
  `packages/orca-lang/src/verifier/shape-and-weights.ts`
  exporting `checkShapeAndWeights(file: OrcaFile,
  machine: MachineDef | SectionsOnlyArtifact) ->
  VerificationResult`.
- [ ] 3.2 Implement `shape_consistency`: walk
  `## transitions` rows; for each row whose action references a
  tensor-typed input or output, unify the input type against
  the source state's declared activation type and the output
  type against the target state's declared activation type.
  Symbolic dims unify by name; emit `SHAPE_MISMATCH` on
  conflict and `SHAPE_NAME_REBINDING` if a name's bound value
  diverges across two transitions.
- [ ] 3.3 Implement `parameter_count`: sum `prod(shape)` across
  all `## weights` rows (skip rows with unresolved symbolic
  dims and emit `PARAMETER_COUNT_UNRESOLVED` warning); compare
  to declared expected value; emit `PARAMETER_COUNT_MISMATCH`
  on inequality.
- [ ] 3.4 Implement `sparsity_bound`: for each `## weights` row
  whose type is `sparse_matrix<...>`, check that the declared
  nnz-per-row metadata (parsed from a sibling
  `<row>.nnz_per_row` field in the type's parameter list, or
  computed from the binary if present) does not exceed the
  declared bound. Emit `SPARSITY_BOUND_VIOLATION`.
- [ ] 3.5 Implement `cluster_completeness`: for the
  `## cluster_manifest`, check that the union of all clusters'
  feature lists covers exactly the feature ID set declared
  in the relevant tensor's shape (or a sidecar
  `feature_ids` field). Emit `CLUSTER_FEATURE_DUPLICATE` for
  features appearing in more than one cluster;
  `CLUSTER_COVERAGE_GAP` for features in the tensor but not in
  any cluster.
- [ ] 3.6 Implement `decoder_norm_preservation`: emit
  `DECODER_NORM_DRIFT` only if both the artifact and the
  reference have binaries present and norms differ beyond
  tolerance; otherwise emit
  `FAITHFULNESS_TEST_SCAFFOLD_REQUIRED` info-level note that
  the runtime harness must check this at build/run time.
- [ ] 3.7 Implement `faithfulness` (declarative): structural
  validation only — metric is a known identifier (allowed
  vocabulary: `kl_divergence`, `mse`, `cosine_similarity`,
  `top1_accuracy`, `top5_accuracy`); threshold parses as
  decimal; distribution and reference are non-empty
  identifiers. Emit `FAITHFULNESS_DECLARATION_MALFORMED`
  on validation failure; otherwise emit
  `FAITHFULNESS_TEST_SCAFFOLD_REQUIRED` info-level note.
- [ ] 3.8 Implement weight-reference integrity: for each
  `weight_ref`, check that `path` resolves relative to the
  artifact directory. If absent, emit
  `WEIGHT_BINARY_MISSING` at warning severity. If present,
  compute the binary's sha256 and compare to the declared
  digest; emit `WEIGHT_HASH_MISMATCH` at error severity on
  inequality. If present and hash matches, attempt to look up
  `key` inside the binary (using a safetensors header parse);
  emit `WEIGHT_KEY_MISSING` at error severity if not found.
- [ ] 3.9 Implement provenance required-set check: if the
  artifact's section set indicates extraction-technique output
  (heuristic: has `## weights` *and* `## faithfulness`, OR has
  `## cluster_manifest`), require a `## provenance` section
  with at least `extraction_technique`, `version`, and
  `config_hash`. Emit `PROVENANCE_REQUIRED` at error severity
  if missing.
- [ ] 3.10 Wire the stage into
  `packages/orca-lang/src/verifier/index.ts` after determinism
  and before properties checking. Add
  `VerifyOptions.skipShapeAndWeights` flag.
- [ ] 3.11 Unit tests in
  `packages/orca-lang/tests/verifier-shape-and-weights.spec.ts`
  covering every new error/warning code (happy path + failure
  per code).

## 4. Examples (3 worked artifacts)

- [ ] 4.1 Author `examples/tiny-transformer.orca.md` — a
  ~10K-parameter GPT-2-class transformer expressed as a
  `# machine`. States are activation tensors with named symbolic
  dims; transitions are attention / MLP / projection
  operations referencing `weight_ref` entries in `## weights`.
  `## verification rules` include `shape_consistency`,
  `parameter_count: 10240`, and a `faithfulness` rule against
  a reference teacher model. (A draft lives at
  `openspec/changes/extend-orca-lang-neural-and-sparse/examples/tiny-transformer.orca.md`.)
- [ ] 4.2 Author `examples/sparse-sae-16f.orca.md` — a
  16-feature group-sparse SAE expressed as a
  sections-only artifact: `## weights` (sparse decoder via
  `sparse_matrix<f32, [16, 512], CSR>`), `## cluster_manifest`
  partitioning the 16 features into 4 clusters of 4,
  `## provenance` (extraction technique = `polygram_v2`),
  `## verification rules` with `cluster_completeness`,
  `sparsity_bound: 4`, and a `decoder_norm_preservation` rule.
- [ ] 4.3 Author `examples/hybrid-transformer-sparse-head.orca.md`
  — a small transformer with a sparse output head, single
  file: `# machine` with tensor-typed states + transitions
  through the transformer body, plus `## weights`,
  `## cluster_manifest` (for the sparse head's feature
  partition), `## provenance`, `## verification rules` mixing
  `shape_consistency`, `parameter_count`, `sparsity_bound`,
  and `cluster_completeness`. Demonstrates that one artifact
  cleanly mixes `## transitions` + `## cluster_manifest`.
- [ ] 4.4 Each example SHALL parse and verify under the
  extended verifier with no errors (warnings allowed for
  `WEIGHT_BINARY_MISSING` because binaries are not checked
  into the spec change). Round-trip through `ast-to-markdown`
  SHALL be byte-stable.

## 5. Regression — existing corpus parses identically

- [ ] 5.1 Author
  `packages/orca-lang/tests/regression-existing-corpus.spec.ts`
  that enumerates all `*.orca.md` and `*.q.orca.md` files
  under `packages/*/examples/` and `packages/*/orca/`,
  parses each with the extended parser, round-trips through
  `ast-to-markdown`, and asserts byte-identical output to the
  pre-extension baseline. (Baseline captured as a fixture
  snapshot in the same test directory.)
- [ ] 5.2 Confirm zero changes to existing `MachineDef`,
  `DecisionTableDef`, or any other existing AST node shape.
  If an AST shape changes, halt and revisit the design — the
  intent is purely additive.

## 6. Documentation

- [ ] 6.1 Update `packages/orca-lang/docs/orca-md-grammar-spec.md`
  with sections for the new types, new sections, and new
  invariants. Include a small example for each.
- [ ] 6.2 Update `docs/error-catalog.md` with entries for the
  twelve new error/warning codes (see proposal). Each entry
  includes cause, fix, and an example.
- [ ] 6.3 Add a "Capability negotiation" note in
  `docs/orca-md-grammar-spec.md` describing the
  `neural-and-sparse-v1` capability string and the
  graceful-degradation contract for consumers that do not
  understand the new sections.

## 7. Spec sync

- [ ] 7.1 Confirm `proposal.md`, `design.md`, and the three
  `specs/<capability>/spec.md` files are mutually consistent —
  every requirement in a spec has a parameter / behavior in
  design; every decision in design has a corresponding
  requirement in some spec.
- [ ] 7.2 If `openspec validate` is wired in this repo
  (it is not at the time of writing — see "Open questions" in
  design), run `openspec validate
  extend-orca-lang-neural-and-sparse --strict` and address any
  issues. Otherwise, manually review against the q-orca repo's
  conventions (which served as the template here).

## 8. End-to-end verification

- [ ] 8.1 Build the orca-lang package (`pnpm build`) and run
  `pnpm test:lang` — all existing 135 tests SHALL pass.
- [ ] 8.2 Run the new parser, verifier, and regression test
  suites — all SHALL pass.
- [ ] 8.3 Run `npx tsx src/index.ts verify` on each of the
  three new examples and confirm clean output (errors empty;
  only the expected `WEIGHT_BINARY_MISSING` warning where
  binaries are absent).
- [ ] 8.4 `pnpm health-check` SHALL still pass end-to-end.

## 9. Parked follow-ups (NOT this change)

- [ ] 9.1 **Parked**: `add-neural-compile-targets` — emit
  PyTorch, ONNX, TFLite, or safetensors-loading runtime glue
  from a verified neural artifact.
- [ ] 9.2 **Parked**: `add-orca-schema-version` — version
  field + capability advertisement, cross-cuts this change
  and others.
- [ ] 9.3 **Parked**: `add-runtime-faithfulness-harness` — the
  actual numerical check (loads binaries, runs the metric on
  the named distribution, compares to threshold). This spec
  describes only the declarative form and the
  test-scaffolding output.
- [ ] 9.4 **Parked**: `extend-orca-algebraic` (`a-orca`),
  `extend-orca-probabilistic` (`p-orca`),
  `extend-orca-circuit` (`c-orca`) — each its own future
  change when a concrete consumer surfaces.
- [ ] 9.5 **Parked**: glob references in `## weights` for
  artifacts with thousands of weight rows. Current design is
  one row per named tensor.
- [ ] 9.6 **Parked**: URI-scheme `weight_ref` paths
  (`s3://...`, `https://...`). Current design is
  relative paths only.
- [ ] 9.7 **Parked**: `sparse_matrix` block-sparse-row (BSR)
  format. Current design supports COO and CSR only.
