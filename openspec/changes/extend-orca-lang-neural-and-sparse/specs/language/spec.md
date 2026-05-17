## ADDED Requirements

### Requirement: Tensor Type

The parser SHALL accept `tensor<dtype, shape>` as a type
expression wherever a type appears (context table, weights table,
decision-table action types, action signatures). `dtype` SHALL be
one of `f16`, `bf16`, `f32`, `f64`, `i8`, `i16`, `i32`, `i64`,
`u8`, `bool`. `shape` SHALL be a bracketed comma-separated list
of dimensions where each dimension is either a non-negative
integer (concrete dim) or an identifier (named symbolic dim).
Symbolic dim names are scoped to a single machine.

#### Scenario: Concrete-shape tensor in context

- **WHEN** a `## context` row declares
  `| activations | tensor<f32, [128, 768]> | |`
- **THEN** the resulting `ContextField` carries a `TensorType`
  with `dtype="f32"` and `shape=[128, 768]`

#### Scenario: Symbolic-shape tensor

- **WHEN** a `## context` row declares
  `| activations | tensor<f32, [batch, seq, hidden]> | |`
- **THEN** the resulting `TensorType` has
  `shape=["batch", "seq", "hidden"]` and the verifier MAY unify
  these names across transitions within the same machine

#### Scenario: Mixed concrete and symbolic dims

- **WHEN** a type expression is `tensor<bf16, [batch, 768]>`
- **THEN** the resulting `TensorType` has
  `shape=["batch", 768]`; subsequent unifications bind `batch`
  to a concrete value while requiring `768` to match exactly

#### Scenario: Inline tensor literal rejected

- **WHEN** a cell typed `tensor<...>` contains a numeric array
  literal such as `[[0.1, 0.2], [0.3, 0.4]]`
- **THEN** the parser emits `INLINE_TENSOR_FORBIDDEN` —
  references are the only supported mechanism for tensor values

### Requirement: Weight Reference Type

The parser SHALL accept `weight_ref<path, sha256, key>` as a
type expression. `path` SHALL be a quoted relative path to a
sidecar binary (typically `*.safetensors`); `sha256` SHALL be a
64-character lowercase hexadecimal digest of the binary file;
`key` SHALL be a quoted identifier naming the tensor inside the
binary.

#### Scenario: Well-formed weight_ref

- **WHEN** a `## weights` row declares the type
  `weight_ref<"weights.safetensors", "a3f1...e0", "transformer.h.0.attn.c_attn.weight">`
- **THEN** the resulting `WeightRefType` has the path, hash, and
  key parsed into their respective string fields

#### Scenario: Malformed hash length

- **WHEN** a `weight_ref` declares `sha256="abc"`
- **THEN** the parser emits a structured error — hash must be a
  64-character hexadecimal string

### Requirement: Sparse Matrix Type

The parser SHALL accept `sparse_matrix<dtype, shape, format>` as
a type expression. `dtype` and `shape` follow the tensor-type
grammar. `format` SHALL be one of `COO`, `CSR`.

#### Scenario: CSR sparse matrix in weights

- **WHEN** a `## weights` row's type is
  `sparse_matrix<f32, [16, 512], CSR>`
- **THEN** the resulting `SparseMatrixType` carries `dtype="f32"`,
  `shape=[16, 512]`, and `format="CSR"`

#### Scenario: Unknown format rejected

- **WHEN** a type is `sparse_matrix<f32, [16, 512], BSR>`
- **THEN** the parser emits a structured error — only COO and
  CSR are supported in this change

### Requirement: Weights Section

The parser SHALL accept an optional `## weights` section whose
table has columns `| name | type | weight_ref | trainable? |`.
Each row declares one named external tensor. `name` is an
identifier; `type` is `tensor<...>` or `sparse_matrix<...>`;
`weight_ref` is a `weight_ref<...>` type expression; `trainable?`
is `true` or `false` (default `false`).

#### Scenario: Declared weight row

- **WHEN** a machine has a `## weights` row
  `| W_qkv | tensor<f32, [768, 2304]> | weight_ref<"w.safetensors", "<64-hex>", "qkv"> | true |`
- **THEN** the resulting `WeightDef` carries the name, the
  tensor type, the weight reference, and `trainable=true`

#### Scenario: Trainable column defaults to false

- **WHEN** a `## weights` row omits the `trainable?` column
- **THEN** the resulting `WeightDef` has `trainable=false`

### Requirement: Cluster Manifest Section

The parser SHALL accept an optional `## cluster_manifest`
section whose table has columns `| cluster | features | size |`.
`cluster` is an identifier or quoted string; `features` is a
comma-separated list of feature IDs (integers or identifiers);
`size` is an integer that SHALL equal `features.length`
(parser-level check via `CLUSTER_SIZE_MISMATCH`).

#### Scenario: Well-formed cluster row

- **WHEN** the manifest has a row
  `| color_cluster | 0, 1, 2, 3 | 4 |`
- **THEN** the resulting `ClusterDef` has
  `name="color_cluster"`, `features=[0, 1, 2, 3]`, `size=4`

#### Scenario: Size mismatch rejected

- **WHEN** a row declares 4 features but `size=5`
- **THEN** the parser emits `CLUSTER_SIZE_MISMATCH`

### Requirement: Faithfulness Section

The parser SHALL accept an optional `## faithfulness` section
whose table has columns
`| metric | threshold | distribution | reference |`. Each row
declares one declarative faithfulness assertion. `metric` SHALL
be from the vocabulary `{kl_divergence, mse, cosine_similarity,
top1_accuracy, top5_accuracy}` (extensible in future changes);
`threshold` SHALL parse as a decimal; `distribution` and
`reference` SHALL be non-empty identifiers.

#### Scenario: Well-formed faithfulness row

- **WHEN** a row declares
  `| kl_divergence | 0.05 | imagenet_val | teacher_model |`
- **THEN** the resulting `FaithfulnessDef` has
  `metric="kl_divergence"`, `threshold=0.05`,
  `distribution="imagenet_val"`, `reference="teacher_model"`

### Requirement: Provenance Section

The parser SHALL accept an optional `## provenance` section as
a two-column key/value table `| field | value |`. Field names
are arbitrary identifiers; the verifier later enforces that
required fields are present for extraction-technique-emitted
artifacts.

#### Scenario: Well-formed provenance section

- **WHEN** a `## provenance` section contains rows for
  `extraction_technique`, `version`, `config_hash`, and
  `benchmark_score`
- **THEN** the resulting `ProvenanceDef` carries a key/value
  map with all four fields

### Requirement: New Invariant Kinds in Verification Rules

The parser SHALL recognize six new invariant kinds in the
`## verification rules` bullet list:
`shape_consistency`, `sparsity_bound: <int>`,
`cluster_completeness`,
`decoder_norm_preservation: tolerance=<decimal>, reference=<id>`,
`parameter_count: <int>`, and
`faithfulness: <metric>, <threshold>, <distribution>, <reference>`.

#### Scenario: shape_consistency bullet

- **WHEN** `## verification rules` contains the bullet
  `- shape_consistency`
- **THEN** the resulting `InvariantDef` has
  `kind="shape_consistency"` and no parameters

#### Scenario: sparsity_bound with parameter

- **WHEN** the bullet is `- sparsity_bound: 8`
- **THEN** the `InvariantDef` has `kind="sparsity_bound"` and
  `params={maxNnzPerRow: 8}`

#### Scenario: parameter_count with parameter

- **WHEN** the bullet is `- parameter_count: 10_240`
- **THEN** the `InvariantDef` has `kind="parameter_count"` and
  `params={expected: 10240}` (underscores in numeric literals
  are stripped during parsing)

#### Scenario: faithfulness invariant

- **WHEN** the bullet is
  `- faithfulness: kl_divergence <= 0.05 under distribution=imagenet_val against reference=teacher_model`
- **THEN** the `InvariantDef` has `kind="faithfulness"` and
  `params={metric: "kl_divergence", threshold: 0.05,
  distribution: "imagenet_val", reference: "teacher_model"}`

### Requirement: Sections-Only Artifact

The parser SHALL accept an `.orca.md` document that contains
none of `# machine`, `# decision_table`, or q-orca top-level
headings, but contains at least one of `## weights`,
`## cluster_manifest`, or `## provenance`. The resulting AST
node SHALL be a `SectionsOnlyArtifact`. A document with only
`## faithfulness` and no anchoring section SHALL be rejected
with `EMPTY_ARTIFACT`.

#### Scenario: Dictionary-style sparse SAE parses as sections-only

- **WHEN** an `.orca.md` document has only `## weights`,
  `## cluster_manifest`, `## provenance`, and
  `## verification rules`
- **THEN** the parser yields an `OrcaFile` with one
  `SectionsOnlyArtifact`, no `MachineDef`, no
  `DecisionTableDef`

#### Scenario: Empty-artifact rejection

- **WHEN** a document contains only `## faithfulness`
- **THEN** the parser emits `EMPTY_ARTIFACT` — faithfulness is
  a contract about an artifact, not the artifact itself

### Requirement: Backward-Compatible Parsing of Existing Artifacts

Every existing `.orca.md` and `.q.orca.md` file that parsed
under the pre-extension grammar SHALL parse identically under
the extended grammar. The resulting AST SHALL round-trip
through `ast-to-markdown` to byte-identical output. The
extension is purely additive — no existing AST node shape, no
existing parsing rule, and no existing error code is modified.

#### Scenario: Pre-extension machine round-trip unchanged

- **WHEN** an existing machine (e.g.
  `examples/payment-processor.orca.md`) is parsed under the
  extended grammar and immediately serialized back via
  `ast-to-markdown`
- **THEN** the output SHALL be byte-identical to the input
