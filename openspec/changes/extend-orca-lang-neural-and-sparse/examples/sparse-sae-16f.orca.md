> Sections-only artifact: a 16-feature group-sparse SAE.
> No `# machine` heading — this artifact is a static dictionary,
> not a state machine. Demonstrates `## cluster_manifest`,
> sparse weight refs, and the `cluster_completeness` /
> `sparsity_bound` / `decoder_norm_preservation` invariants.

## weights

| name        | type                                          | weight_ref                                                                                           | trainable? |
|-------------|-----------------------------------------------|------------------------------------------------------------------------------------------------------|------------|
| W_enc       | tensor<f32, [16, 512]>                        | weight_ref<"sae-16f.safetensors", "0000000000000000000000000000000000000000000000000000000000000000", "encoder.weight"> | true       |
| W_dec       | sparse_matrix<f32, [16, 512], CSR>            | weight_ref<"sae-16f.safetensors", "0000000000000000000000000000000000000000000000000000000000000000", "decoder.weight"> | true       |
| b_enc       | tensor<f32, [16]>                             | weight_ref<"sae-16f.safetensors", "0000000000000000000000000000000000000000000000000000000000000000", "encoder.bias">   | true       |
| W_dec_baseline | sparse_matrix<f32, [16, 512], CSR>         | weight_ref<"sae-16f-baseline.safetensors", "0000000000000000000000000000000000000000000000000000000000000000", "decoder.weight"> | false |

## cluster_manifest

| cluster   | features      | size |
|-----------|---------------|------|
| color     | 0, 1, 2, 3    | 4    |
| shape     | 4, 5, 6, 7    | 4    |
| texture   | 8, 9, 10, 11  | 4    |
| motion    | 12, 13, 14, 15 | 4   |

## provenance

| field                | value                                                                |
|----------------------|----------------------------------------------------------------------|
| extraction_technique | polygram_v2.group_sparse                                             |
| version              | 1.2.0                                                                |
| config_hash          | sha256:3333333333333333333333333333333333333333333333333333333333333333 |
| source_sae_hash      | sha256:4444444444444444444444444444444444444444444444444444444444444444 |

## verification rules

- cluster_completeness
- sparsity_bound: 4
- decoder_norm_preservation: tolerance=0.01, reference=W_dec_baseline

> Notes:
>
> The decoder is declared as `sparse_matrix<f32, [16, 512], CSR>`
> with `sparsity_bound: 4` — at most 4 nonzeros per feature row.
> `cluster_completeness` checks the partition: 16 features in
> 4 disjoint clusters of 4. The verifier emits
> CLUSTER_FEATURE_DUPLICATE if any feature appears twice, and
> CLUSTER_COVERAGE_GAP if any feature is unassigned.
>
> `decoder_norm_preservation` declares the scale-aware merge
> contract: the live decoder's column norms must match
> `W_dec_baseline`'s norms within 0.01. Because the verifier
> cannot compute norms without binaries present, it emits
> FAITHFULNESS_TEST_SCAFFOLD_REQUIRED at info severity — the
> runtime harness owes the actual check.
