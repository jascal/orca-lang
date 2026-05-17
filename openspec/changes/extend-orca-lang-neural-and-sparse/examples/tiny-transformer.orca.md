# machine TinyTransformer

> A toy ~10K-parameter GPT-2-class transformer (1 layer, 2 attention
> heads, hidden=64, seq=8, vocab=64). States are activation
> tensors; transitions are layer operations. Weights are referenced
> from a sibling `tiny-transformer.safetensors`. Demonstrates
> tensor types, weight refs, parameter_count, and faithfulness.

## context

| Field      | Type                                  | Default |
|------------|---------------------------------------|---------|
| input_ids  | tensor<i32, [batch, seq]>             |         |
| embedded   | tensor<f32, [batch, seq, hidden]>     |         |
| attended   | tensor<f32, [batch, seq, hidden]>     |         |
| mlp_out    | tensor<f32, [batch, seq, hidden]>     |         |
| logits     | tensor<f32, [batch, seq, vocab]>      |         |

## events

- forward

## state input [initial]
> Token IDs available; no computation has run yet.

## state embedded_state
> Token embeddings + positional embeddings applied.

## state attended_state
> Self-attention output added back via residual.

## state mlp_state
> Feed-forward MLP applied + residual + layer norm.

## state logits_state [final]
> Output projection to vocab logits.

## transitions

| Source           | Event   | Guard | Target            | Action     |
|------------------|---------|-------|-------------------|------------|
| input            | forward |       | embedded_state    | embed      |
| embedded_state   | forward |       | attended_state    | attention  |
| attended_state   | forward |       | mlp_state         | mlp_block  |
| mlp_state        | forward |       | logits_state      | unembed    |

## actions

| Name      | Signature                                                                                              |
|-----------|--------------------------------------------------------------------------------------------------------|
| embed     | `(ctx, event) -> Context`                                                                              |
| attention | `(ctx, event) -> Context`                                                                              |
| mlp_block | `(ctx, event) -> Context`                                                                              |
| unembed   | `(ctx, event) -> Context`                                                                              |

## weights

| name      | type                                          | weight_ref                                                                                          | trainable? |
|-----------|-----------------------------------------------|-----------------------------------------------------------------------------------------------------|------------|
| W_embed   | tensor<f32, [vocab, hidden]>                  | weight_ref<"tiny-transformer.safetensors", "0000000000000000000000000000000000000000000000000000000000000000", "embed.weight"> | true       |
| W_pos     | tensor<f32, [seq, hidden]>                    | weight_ref<"tiny-transformer.safetensors", "0000000000000000000000000000000000000000000000000000000000000000", "pos.weight">   | true       |
| W_qkv     | tensor<f32, [hidden, 3, hidden]>              | weight_ref<"tiny-transformer.safetensors", "0000000000000000000000000000000000000000000000000000000000000000", "h.0.attn.qkv"> | true       |
| W_attn_o  | tensor<f32, [hidden, hidden]>                 | weight_ref<"tiny-transformer.safetensors", "0000000000000000000000000000000000000000000000000000000000000000", "h.0.attn.o">   | true       |
| W_mlp_in  | tensor<f32, [hidden, 4, hidden]>              | weight_ref<"tiny-transformer.safetensors", "0000000000000000000000000000000000000000000000000000000000000000", "h.0.mlp.in">   | true       |
| W_mlp_out | tensor<f32, [4, hidden, hidden]>              | weight_ref<"tiny-transformer.safetensors", "0000000000000000000000000000000000000000000000000000000000000000", "h.0.mlp.out">  | true       |
| W_unembed | tensor<f32, [hidden, vocab]>                  | weight_ref<"tiny-transformer.safetensors", "0000000000000000000000000000000000000000000000000000000000000000", "unembed.weight"> | true     |

## provenance

| field                | value                                                                |
|----------------------|----------------------------------------------------------------------|
| extraction_technique | sae_forge_v1.distill                                                 |
| version              | 0.4.2                                                                |
| config_hash          | sha256:1111111111111111111111111111111111111111111111111111111111111111 |
| source_sae_hash      | sha256:2222222222222222222222222222222222222222222222222222222222222222 |
| benchmark_score      | 0.972                                                                |

## faithfulness

| metric        | threshold | distribution  | reference      |
|---------------|-----------|---------------|----------------|
| kl_divergence | 0.05      | imagenet_val  | teacher_model  |

## verification rules

- shape_consistency
- parameter_count: 11392
- faithfulness: kl_divergence <= 0.05 under distribution=imagenet_val against reference=teacher_model

> Notes:
>
> Symbolic dims `batch`, `seq`, `hidden`, `vocab` unify across the
> machine. The parameter_count sum is purely the declared weight
> shapes:
>   embed: 64*64 = 4096
>   pos:   8*64  = 512
>   qkv:   64*3*64 = 12288  → this dominates; the toy keeps it small
>     by using a tied projection in the implementation, but the
>     declaration is the full shape.
> The 11392 value here is illustrative; actual fixture will be
> recomputed by `parameter_count` once binaries land. The verifier
> emits PARAMETER_COUNT_MISMATCH if the sum does not match — that
> is the intended self-correcting behavior of the invariant.
