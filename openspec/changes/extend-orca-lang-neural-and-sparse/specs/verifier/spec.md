## MODIFIED Requirements

### Requirement: Verifier Pipeline Order

The verifier SHALL run stages in the following order:
structural, completeness, determinism, **shape-and-weights
(new)**, properties. If the structural stage produces any
error, later stages SHALL be skipped. Otherwise, every
non-skipped stage SHALL run and their errors SHALL be merged
into a single result. The new shape-and-weights stage SHALL
run only on machines or sections-only artifacts that contain
at least one tensor type, weight reference, sparse matrix
type, or new section; otherwise it SHALL no-op so existing
artifacts incur zero verification cost.

#### Scenario: Existing machine skips the new stage

- **WHEN** a machine has no tensor types, no weight refs, no
  sparse matrices, and none of the new sections
- **THEN** `verify()` SHALL skip the shape-and-weights stage
  entirely; verification cost and error output SHALL be
  identical to pre-extension behavior

#### Scenario: Machine with tensor types runs the new stage

- **WHEN** a machine has a `## weights` section with at least
  one weight row
- **THEN** the shape-and-weights stage runs after determinism
  and before properties

## ADDED Requirements

### Requirement: Shape Consistency Check

The verifier SHALL evaluate `shape_consistency` invariants by
walking the `## transitions` table and unifying each
transition action's input tensor type against its source state's
declared activation type, and its output tensor type against
its target state's declared activation type. Symbolic dim names
SHALL unify by name; concrete dims SHALL unify by value. Errors:
- `SHAPE_MISMATCH` (error) — declared shape does not match
  expected shape at a transition boundary.
- `SHAPE_NAME_REBINDING` (error) — a symbolic dim name binds
  to two divergent concrete values across transitions in the
  same machine.

#### Scenario: Two transitions agree on a symbolic dim

- **WHEN** a machine declares
  `tensor<f32, [batch, 768]>` on both the input and output of
  a `linear` transition, with `batch` bound elsewhere to `128`
- **THEN** the shape-consistency check passes for that
  transition

#### Scenario: Concrete dim mismatch

- **WHEN** a transition action produces `tensor<f32, [128, 768]>`
  but the target state's activation is
  `tensor<f32, [128, 512]>`
- **THEN** the verifier emits `SHAPE_MISMATCH` at error severity
  with a message naming the conflicting dim (index 1: expected
  512, got 768)

#### Scenario: Symbolic dim rebinding

- **WHEN** transition A binds `seq=128` and transition B in the
  same machine binds `seq=64` for the same symbolic dim
- **THEN** the verifier emits `SHAPE_NAME_REBINDING` at error
  severity

### Requirement: Parameter Count Check

The verifier SHALL evaluate `parameter_count: <expected>`
invariants by summing `prod(shape)` across all `## weights`
rows. Rows whose shape contains unresolved symbolic dims at
verification time SHALL be skipped with a
`PARAMETER_COUNT_UNRESOLVED` warning, and the resulting
partial sum SHALL be compared against the declared expected
value. Errors:
- `PARAMETER_COUNT_MISMATCH` (error) — sum of resolved
  weight-row element counts does not equal the declared value.
- `PARAMETER_COUNT_UNRESOLVED` (warning) — one or more rows
  could not be summed due to unresolved symbolic dims.

#### Scenario: Sum equals declared value

- **WHEN** a machine declares two weight rows of shapes
  `[10, 100]` and `[100, 1]` and the invariant
  `- parameter_count: 1100`
- **THEN** the check passes silently

#### Scenario: Mismatch

- **WHEN** the rows total `1100` but the invariant is
  `- parameter_count: 10240`
- **THEN** the verifier emits `PARAMETER_COUNT_MISMATCH` at
  error severity, naming the actual and expected totals

### Requirement: Sparsity Bound Check

The verifier SHALL evaluate `sparsity_bound: <max_nnz_per_row>`
invariants by inspecting every `## weights` row of type
`sparse_matrix<...>` and comparing the declared or computed
nnz-per-row against the bound. If the binary is present, the
nnz is computed from the safetensor's indices; otherwise the
parser-declared metadata is used. Error: `SPARSITY_BOUND_VIOLATION`
(error).

#### Scenario: Sparse decoder within bound

- **WHEN** a sparse decoder has at most 4 nonzeros per row and
  the invariant is `- sparsity_bound: 8`
- **THEN** the check passes silently

#### Scenario: Bound exceeded

- **WHEN** a sparse decoder has up to 12 nonzeros per row and
  the invariant is `- sparsity_bound: 8`
- **THEN** the verifier emits `SPARSITY_BOUND_VIOLATION` at
  error severity, identifying the offending row(s)

### Requirement: Cluster Completeness Check

The verifier SHALL evaluate `cluster_completeness` invariants
by computing the union of all clusters' feature lists in the
`## cluster_manifest` and comparing this set to the relevant
tensor's feature ID set (taken from the tensor's shape's
feature dim or a sidecar `feature_ids` field). Errors:
- `CLUSTER_FEATURE_DUPLICATE` (error) — a feature ID appears
  in more than one cluster.
- `CLUSTER_COVERAGE_GAP` (error) — a feature ID exists in the
  tensor but is not in any cluster.

#### Scenario: Complete partition

- **WHEN** four clusters of four features each cover features
  0–15 with no overlap and the tensor has 16 features
- **THEN** the check passes silently

#### Scenario: Duplicate feature

- **WHEN** feature 3 appears in both `cluster_a` and
  `cluster_b`
- **THEN** the verifier emits `CLUSTER_FEATURE_DUPLICATE` at
  error severity, naming the feature and both clusters

#### Scenario: Coverage gap

- **WHEN** the tensor has 16 features but feature 15 is in no
  cluster
- **THEN** the verifier emits `CLUSTER_COVERAGE_GAP` at error
  severity, naming the missing feature

### Requirement: Decoder Norm Preservation Check (Declarative)

The verifier SHALL evaluate `decoder_norm_preservation:
tolerance=<t>, reference=<R>` invariants structurally: the
named reference SHALL resolve to a declared weight or provenance
entry; the tolerance SHALL parse as a decimal. The numerical
check is out of scope (runs at build/run time in
`add-runtime-faithfulness-harness`). Verifier behavior:
- If both the artifact's decoder weight and the reference are
  resolvable and both binaries are present, the verifier MAY
  compute column norms and emit `DECODER_NORM_DRIFT` (error)
  if any norm differs from the reference beyond tolerance.
- Otherwise, the verifier SHALL emit
  `FAITHFULNESS_TEST_SCAFFOLD_REQUIRED` (info) noting that the
  runtime harness is responsible for the actual check.

#### Scenario: Reference resolves; binaries absent

- **WHEN** the invariant is
  `- decoder_norm_preservation: tolerance=0.01, reference=W_dec_baseline`
  and `W_dec_baseline` resolves but its binary is not present
- **THEN** the verifier emits
  `FAITHFULNESS_TEST_SCAFFOLD_REQUIRED` at info severity

#### Scenario: Reference does not resolve

- **WHEN** the invariant references `W_baseline` and no such
  weight or provenance field is declared anywhere in the file
- **THEN** the verifier emits `DECODER_NORM_DRIFT` at error
  severity, message `unresolved reference: W_baseline`

### Requirement: Faithfulness Check (Declarative)

The verifier SHALL validate `faithfulness` declarations
(whether they appear as a `## faithfulness` section row or as
an inline `## verification rules` bullet) structurally:
- `metric` SHALL be in the allowed vocabulary
  (`kl_divergence`, `mse`, `cosine_similarity`,
  `top1_accuracy`, `top5_accuracy`). Otherwise:
  `FAITHFULNESS_DECLARATION_MALFORMED` (error).
- `threshold` SHALL parse as a decimal.
- `distribution` and `reference` SHALL be non-empty identifiers.

If validation passes, the verifier SHALL emit
`FAITHFULNESS_TEST_SCAFFOLD_REQUIRED` at info severity,
recording that the runtime harness owes the actual numerical
check.

#### Scenario: Well-formed faithfulness declaration

- **WHEN** a row reads
  `| kl_divergence | 0.05 | imagenet_val | teacher_model |`
- **THEN** the verifier emits
  `FAITHFULNESS_TEST_SCAFFOLD_REQUIRED` at info severity

#### Scenario: Unknown metric

- **WHEN** the metric is `mahalanobis_distance`
- **THEN** the verifier emits
  `FAITHFULNESS_DECLARATION_MALFORMED` at error severity

### Requirement: Weight Reference Integrity Check

The verifier SHALL check each `weight_ref` as follows:
1. Resolve `path` relative to the artifact directory.
2. If the binary is **absent**, emit `WEIGHT_BINARY_MISSING`
   at **warning** severity and move on. The artifact remains
   valid for static analysis.
3. If the binary is **present**, compute its sha256 digest. On
   mismatch with the declared digest, emit
   `WEIGHT_HASH_MISMATCH` at **error** severity.
4. If the binary is present and the hash matches, parse the
   safetensors header and check that `key` is among its tensor
   names. On miss, emit `WEIGHT_KEY_MISSING` at **error**
   severity.

#### Scenario: Binary absent — review-friendly behavior

- **WHEN** `weight_ref` points to `weights.safetensors` and
  that file does not exist next to the artifact
- **THEN** the verifier emits `WEIGHT_BINARY_MISSING` at
  warning severity and continues; verification overall
  succeeds (no errors)

#### Scenario: Binary present, hash diverges

- **WHEN** the binary exists but its sha256 differs from the
  declared digest
- **THEN** the verifier emits `WEIGHT_HASH_MISMATCH` at error
  severity

#### Scenario: Binary present, key missing

- **WHEN** the binary's hash matches but the declared `key`
  does not appear among the binary's tensor names
- **THEN** the verifier emits `WEIGHT_KEY_MISSING` at error
  severity

### Requirement: Provenance Required-Set Check

The verifier SHALL detect extraction-technique-emitted
artifacts heuristically: any artifact that contains `## weights`
*and* `## faithfulness`, or any artifact that contains
`## cluster_manifest`, is treated as extraction-technique
output. Such an artifact SHALL declare a `## provenance`
section containing at minimum `extraction_technique`,
`version`, and `config_hash`. Error: `PROVENANCE_REQUIRED`
(error).

#### Scenario: Sparse SAE artifact requires provenance

- **WHEN** an artifact has `## cluster_manifest` but no
  `## provenance` section
- **THEN** the verifier emits `PROVENANCE_REQUIRED` at error
  severity

#### Scenario: Standalone machine with no extraction signal

- **WHEN** an artifact has a `# machine` heading, no
  `## weights`, no `## cluster_manifest`
- **THEN** no provenance is required; no error is emitted

### Requirement: Inline Tensor Literals Forbidden

The verifier SHALL re-affirm at stage entry that no
`weight_ref` cell or tensor-typed context value contains a raw
inline tensor literal. The primary check is performed at parse
time (`INLINE_TENSOR_FORBIDDEN`); the verifier re-checks defensively
and emits the same code at error severity if reached.

#### Scenario: Defensive re-check

- **WHEN** a malformed AST (constructed programmatically rather
  than parsed) carries an inline tensor literal in a
  tensor-typed slot
- **THEN** the verifier emits `INLINE_TENSOR_FORBIDDEN` at
  error severity

### Requirement: Capability Negotiation Note

The verifier SHALL document, in its result metadata, whether
the artifact uses any feature from the
`neural-and-sparse-v1` capability set (new types or new
sections). Consumers MAY use this flag to decide whether to
load runtime modules required for downstream consumption. The
verifier does not itself reject artifacts based on consumer
capability — that contract belongs to the loading consumer.

#### Scenario: Capability flag set when new sections present

- **WHEN** an artifact uses `## weights` or any of the other
  new sections
- **THEN** `verifyResult.capabilities` includes
  `"neural-and-sparse-v1"`

#### Scenario: Capability flag absent for existing-only artifacts

- **WHEN** an artifact uses only pre-extension grammar
- **THEN** `verifyResult.capabilities` does not include
  `"neural-and-sparse-v1"`
