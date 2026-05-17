# machine HybridTransformerSparseHead

> Small transformer body + sparse output head in one artifact.
> The transformer body uses dense tensors and transitions; the
> output head uses a sparse matrix and a cluster manifest. This
> example demonstrates that `## transitions` and
> `## cluster_manifest` mix cleanly in a single file, and that
> one machine's `## verification rules` can combine dense and
> sparse invariants.

## context

| Field      | Type                                  | Default |
|------------|---------------------------------------|---------|
| input_ids  | tensor<i32, [batch, seq]>             |         |
| embedded   | tensor<f32, [batch, seq, hidden]>     |         |
| attended   | tensor<f32, [batch, seq, hidden]>     |         |
| pooled     | tensor<f32, [batch, hidden]>          |         |
| features   | tensor<f32, [batch, n_features]>      |         |

## events

- forward

## state input [initial]
> Token IDs in.

## state embedded_state
> Embeddings applied.

## state attended_state
> Self-attention block applied.

## state pooled_state
> Mean-pooled across sequence dim.

## state features_state [final]
> Sparse output head produces per-feature activations.

## transitions

| Source           | Event   | Guard | Target            | Action       |
|------------------|---------|-------|-------------------|--------------|
| input            | forward |       | embedded_state    | embed        |
| embedded_state   | forward |       | attended_state    | attention    |
| attended_state   | forward |       | pooled_state      | mean_pool    |
| pooled_state     | forward |       | features_state    | sparse_head  |

## actions

| Name        | Signature                  |
|-------------|----------------------------|
| embed       | `(ctx, event) -> Context`  |
| attention   | `(ctx, event) -> Context`  |
| mean_pool   | `(ctx, event) -> Context`  |
| sparse_head | `(ctx, event) -> Context`  |

## weights

| name        | type                                            | weight_ref                                                                                            | trainable? |
|-------------|-------------------------------------------------|-------------------------------------------------------------------------------------------------------|------------|
| W_embed     | tensor<f32, [vocab, hidden]>                    | weight_ref<"hybrid.safetensors", "0000000000000000000000000000000000000000000000000000000000000000", "embed.weight">   | true       |
| W_attn_qkv  | tensor<f32, [hidden, 3, hidden]>                | weight_ref<"hybrid.safetensors", "0000000000000000000000000000000000000000000000000000000000000000", "attn.qkv">       | true       |
| W_attn_o    | tensor<f32, [hidden, hidden]>                   | weight_ref<"hybrid.safetensors", "0000000000000000000000000000000000000000000000000000000000000000", "attn.o">         | true       |
| W_head      | sparse_matrix<f32, [hidden, n_features], CSR>   | weight_ref<"hybrid.safetensors", "0000000000000000000000000000000000000000000000000000000000000000", "head.weight">    | true       |

## cluster_manifest

| cluster      | features              | size |
|--------------|-----------------------|------|
| concrete     | 0, 1, 2, 3, 4, 5      | 6    |
| abstract     | 6, 7, 8, 9, 10, 11    | 6    |
| relational   | 12, 13, 14, 15        | 4    |

## provenance

| field                | value                                                                |
|----------------------|----------------------------------------------------------------------|
| extraction_technique | sae_forge_v1.distill+polygram_v2.group_sparse                        |
| version              | 0.5.0                                                                |
| config_hash          | sha256:5555555555555555555555555555555555555555555555555555555555555555 |
| source_sae_hash      | sha256:6666666666666666666666666666666666666666666666666666666666666666 |

## faithfulness

| metric        | threshold | distribution  | reference          |
|---------------|-----------|---------------|--------------------|
| kl_divergence | 0.05      | imagenet_val  | teacher_model      |
| mse           | 0.001     | imagenet_val  | sae_dense_baseline |

## verification rules

- shape_consistency
- parameter_count: 327424
- sparsity_bound: 4
- cluster_completeness
- faithfulness: kl_divergence <= 0.05 under distribution=imagenet_val against reference=teacher_model

> Notes:
>
> Symbolic dims `batch`, `seq`, `hidden`, `vocab`, `n_features`
> unify across the machine. `n_features` is bound to 16 by the
> cluster_manifest (6 + 6 + 4 = 16). `shape_consistency` walks
> the transition graph and checks that each layer's output type
> matches the next state's expected activation. `sparsity_bound`
> applies only to `W_head` (the only sparse_matrix in the
> artifact). `cluster_completeness` applies to the sparse head's
> output features.
>
> This artifact triggers `PROVENANCE_REQUIRED` if `## provenance`
> is omitted, because it has both `## weights` + `## faithfulness`
> AND `## cluster_manifest`.
