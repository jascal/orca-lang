# orca-nanolab: Intelligent nanoGPT Training Orchestrator

> An LLM-generated state machine that orchestrates the training and tuning of another LLM — using Karpathy's nanoGPT as the training engine and Orca as the workflow brain.

## Overview

This demo uses Orca state machines to orchestrate nanoGPT training runs: data preparation, parallel hyperparameter search, adaptive training, evaluation, and full audit logging. It serves dual purpose as both a compelling real-world demo and a **forcing function** to add missing production features to the Orca framework.

### The Recursive Narrative

Claude generates Orca machines that manage GPT-2 training runs, evaluate results, adapt hyperparameters, and persist the full audit trail. After a run, the audit log can be fed back to Claude to refine the `.orca.md` — the workflow improves itself.

## Why nanoGPT

| Property | Why it matters |
|----------|---------------|
| **~300 lines of training code** | Simple enough to wrap, complex enough to orchestrate |
| **Pure Python** | Matches `orca-runtime-python` |
| **Character-level Shakespeare** | Trains in ~3 min on GPU — fast iteration for demos |
| **Rich hyperparameter space** | 20+ tunable knobs (lr, n_layer, n_head, dropout, batch_size...) |
| **Checkpoint/resume built in** | Natural fit for snapshot/restore |
| **HellaSwag eval** (from build-nanogpt) | Structured eval beyond just loss |
| **Most recognizable ML training repo** | Instant credibility |

### Source Projects

- **nanoGPT** (github.com/karpathy/nanoGPT) — core training engine, ~300 line train.py, ~300 line model.py
- **build-nanogpt** (github.com/karpathy/build-nanogpt) — adds HellaSwag evaluation, FineWeb-Edu dataset, cleaner training loop

### nanoGPT Key Details

**Hyperparameters** (all configurable via CLI or config files):
- I/O: `out_dir`, `eval_interval`, `eval_iters`, `init_from` (scratch/resume/gpt2)
- Data: `dataset`, `batch_size`, `block_size`, `gradient_accumulation_steps`
- Model: `n_layer`, `n_head`, `n_embd`, `dropout`, `bias`
- Optimizer: `learning_rate`, `max_iters`, `weight_decay`, `beta1`, `beta2`, `grad_clip`
- LR schedule: `warmup_iters`, `lr_decay_iters`, `min_lr`, `decay_lr`

**Checkpoint format** (`ckpt.pt`): model state, optimizer state, model_args, iter_num, best_val_loss, config dict.

**Datasets**: openwebtext (~54GB), shakespeare (BPE), shakespeare_char (character-level, fast).

## Multi-Machine Architecture

```
TrainingLab (coordinator)
  ├── DataPipeline (child) — tokenize, validate, split
  ├── TrainingRun (child) — single run with early stopping
  ├── Evaluator (child) — loss + generation quality + optional HellaSwag
  └── HyperSearch (parallel) — run N configs, compare, select best
        ├── region trial_a → invokes TrainingRun
        └── region trial_b → invokes TrainingRun
```

### Machine 1: TrainingLab (top-level orchestrator)

```
States: idle → preparing_data → searching → training_best → evaluating → completed / failed
```

- Invokes DataPipeline first, then HyperSearch (parallel trials), then trains the winner to convergence, then runs full evaluation
- Guards: `ctx.best_val_loss < ctx.target_loss`, `ctx.budget_remaining > 0`
- Timeout: overall experiment budget (e.g., 30 min)

### Machine 2: DataPipeline

```
States: checking → downloading → tokenizing → validating → ready / error
```

- Effects: `FileSystem` (check if data exists), `ShellExec` (run prepare.py), `DataValidation` (verify bin files)
- Idempotent — skips steps if data already prepared

### Machine 3: TrainingRun

```
States: initializing → training → evaluating → checkpointing → training (loop) → converged / diverged / timed_out
```

This is the core loop — wraps nanoGPT's train.py as a managed subprocess.

- Guards: `ctx.val_loss < ctx.best_val_loss` (save checkpoint), `ctx.iter > ctx.max_iters` (done), `ctx.val_loss > ctx.prev_val_loss * 1.5` (divergence detection)
- Effects: `TrainStep` (run N iterations), `EstimateLoss` (run eval), `SaveCheckpoint`, `LoadCheckpoint`
- Timeout: per-run time budget

### Machine 4: Evaluator

```
States: loading_model → computing_loss → generating_samples → scoring → done / error
```

- Effects: `ModelLoad`, `LossEstimate`, `TextGenerate`, `QualityScore`
- Context accumulates: `{ val_loss, train_loss, sample_text, hellaswag_acc }`

### Machine 5: HyperSearch (parallel regions)

```
States: configuring [initial] → running [parallel, sync: all-final] → comparing → selected / exhausted

Region trial_a: invoke TrainingRun with config A
Region trial_b: invoke TrainingRun with config B
```

- On completion, compares trial results and selects best config
- Guard: `ctx.trial_a_loss < ctx.trial_b_loss`

## New Framework Features (Forcing Functions)

This demo **cannot work** without features Orca doesn't have yet. Each becomes a concrete framework work item.

### 1. `## effects` Section in the Language

**The gap**: Actions can declare `+ Effect<Type>` but the effect types themselves are undefined — no schema, no documentation, no verification.

**What we need**:

```markdown
## effects
| Name           | Input                                         | Output                                      |
|----------------|-----------------------------------------------|---------------------------------------------|
| ShellExec      | `{ cmd: string, cwd: string }`                | `{ exit_code: int, stdout: string }`        |
| TrainStep      | `{ config: TrainConfig, steps: int }`         | `{ iter: int, train_loss: float, lr: float }`|
| EstimateLoss   | `{ checkpoint: string, eval_iters: int }`     | `{ train_loss: float, val_loss: float }`    |
| TextGenerate   | `{ checkpoint: string, prompt: string, max_tokens: int }` | `{ text: string }`            |
| SaveCheckpoint | `{ dir: string }`                             | `{ path: string, size_mb: float }`          |
```

**What this enables**:
- Verifier can check that actions reference defined effects
- LLM code generation for effect handlers gets typed signatures
- Documentation is self-contained in the `.orca.md` file
- Runtime can validate effect payloads

### 2. `## persistence` Declaration

**The gap**: Snapshot/restore exists but is in-memory only. No way to declare "this workflow should survive process restarts."

**What we need**:

```markdown
## persistence
| Strategy | Location                      | On         |
|----------|-------------------------------|------------|
| file     | `./runs/{run_id}/state.json`  | transition |
```

**What this enables**:
- Training runs that survive crashes and resume automatically
- Audit trail of every state transition with timestamps
- Experiment reproducibility — full history of how you got to the final model

### 3. `## logging` / Workflow Audit Trail

**The gap**: The event bus publishes events internally but there's no structured, persistent, queryable log.

**What we need**:

```markdown
## logging
| Sink    | Format | Events                            |
|---------|--------|-----------------------------------|
| file    | jsonl  | transitions, effects, checkpoints |
| console | pretty | transitions, errors               |
```

Each log entry:

```json
{
  "ts": "2026-03-27T10:15:32Z",
  "machine": "TrainingRun",
  "event": "EVAL_COMPLETE",
  "from": "evaluating",
  "to": "checkpointing",
  "context_delta": { "val_loss": 1.48, "best_val_loss": 1.48 },
  "effect": { "type": "EstimateLoss", "duration_ms": 4200 },
  "run_id": "exp-001"
}
```

**What this enables**:
- Post-hoc analysis of training decisions
- "Why did the orchestrator choose config A over B?" is answerable from the log
- Integration with experiment tracking (W&B, MLflow) as a log sink

### 4. Long-Running / Async Effects

**The gap**: Current effects are fire-and-forget or quick async calls. Training a model for 3 minutes (or 3 hours) is fundamentally different.

**What we need**:
- Effect type annotation: `Effect<TrainStep, long_running>`
- Progress callbacks: effect can emit intermediate events (`TRAIN_PROGRESS { iter: 500, loss: 2.1 }`)
- Cancellation: if the machine transitions away, the effect's subprocess gets killed
- This maps naturally to nanoGPT's training loop — we wrap `train.py` as a managed subprocess with log tailing

### 5. Context Schema Validation & Accumulation

**The gap**: Context is `dict[str, any]` — no runtime type checking, no way to declare that `val_loss_history` is an appending list.

**What we need**:

```markdown
## context
| Field            | Type        | Default | Mode      |
|------------------|-------------|---------|-----------|
| val_loss         | float       |         |           |
| best_val_loss    | float       | 999.0   |           |
| loss_history     | float[]     | []      | append    |
| config           | TrainConfig |         |           |
| budget_remaining | int         | 1800    | decrement |
```

The `mode` column (append, decrement, etc.) tells the runtime how effects update that field — critical for training metrics that accumulate over time.

## Demo Output

What the running demo looks like:

```
$ python -m orca_nanolab --dataset shakespeare_char --budget 10m --trials 2

🔬 orca-nanolab: nanoGPT Training Orchestrator
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📂 DataPipeline ▸ checking → downloading → tokenizing → ready  ✓ (12s)
   └─ shakespeare_char: 1,003,854 chars, train.bin (924KB), val.bin (103KB)

🔍 HyperSearch ▸ configuring → running [parallel]
   ┌─ trial_a: lr=6e-4, n_layer=4, n_head=4, dropout=0.0
   │  ├─ TrainingRun ▸ training... iter 500/2000, loss=2.31, lr=5.8e-4
   │  └─ TrainingRun ▸ training... iter 1000/2000, loss=1.82, lr=4.2e-4
   │
   └─ trial_b: lr=3e-4, n_layer=6, n_head=6, dropout=0.1
      ├─ TrainingRun ▸ training... iter 500/2000, loss=2.18, lr=2.9e-4
      └─ TrainingRun ▸ training... iter 1000/2000, loss=1.71, lr=2.1e-4

   ▸ comparing → selected trial_b (val_loss: 1.71 < 1.82)  ✓

🏋️ TrainingBest ▸ training trial_b to convergence (budget: 6m remaining)
   ├─ iter 2000, loss=1.61  ckpt ✓
   ├─ iter 3000, loss=1.54  ckpt ✓
   └─ iter 4000, loss=1.52  ckpt ✓  converged (Δloss < 0.01)

📊 Evaluator ▸ loading → computing_loss → generating_samples → done  ✓
   ├─ val_loss: 1.52
   ├─ sample: "ROMEO: What light through yonder window breaks..."
   └─ quality: coherent_sentences=8/10

✅ TrainingLab ▸ completed
   └─ run log: ./runs/exp-001/audit.jsonl (847 events)
   └─ best model: ./runs/exp-001/ckpt.pt (val_loss=1.52)
   └─ total time: 8m32s, budget used: 8m/10m
```

## Implementation Plan

| Phase | What | Forces Feature | Demoable? |
|-------|------|----------------|-----------|
| **0** | Fork/vendor nanoGPT's `train.py` + `model.py` into demo | — | No |
| **1** | Single TrainingRun machine — wrap train.py as subprocess effect | Long-running effects, `ShellExec` effect | Yes — single training run |
| **2** | Add `## effects` section to language + verifier | **Effects in language** | Yes — verified machine |
| **3** | Add DataPipeline + Evaluator child machines | Machine invocation in Python | Yes — full pipeline |
| **4** | Add HyperSearch with parallel trials | Parallel regions + invocation | Yes — parallel search |
| **5** | Add persistence — resume crashed experiments | **Persistence declaration** | Yes — crash recovery |
| **6** | Add structured logging — full audit trail | **Logging declaration** | Yes — experiment analysis |
| **7** | Add interactive CLI display (rich/textual) | — | Yes — polished UX |
| **8** | LLM-generated workflow refinement | `/refine-orca` on training results | Yes — self-improving |

Phase 8 is the capstone: after a training run, feed the audit log back to Claude and ask it to refine the `.orca.md` — adjust hyperparameter ranges, add early stopping guards, change the search strategy. The workflow improves itself.

## Package Structure

```
packages/demo-nanolab/
  pyproject.toml
  orca/
    training-lab.orca.md          # All 5 machines in one file
  nanolab/
    __init__.py
    __main__.py                   # CLI entry point
    vendor/
      train.py                    # Vendored from nanoGPT (modified for subprocess use)
      model.py                    # Vendored from nanoGPT
      configurator.py
    handlers/
      data_pipeline.py            # Effect handlers for data prep
      training.py                 # Effect handlers for train step, checkpoint
      evaluation.py               # Effect handlers for loss, generation, scoring
    display/
      terminal.py                 # Rich/textual live display
    persistence/
      file_store.py               # JSON file persistence adapter
    logging/
      audit.py                    # JSONL audit trail writer
  data/
    shakespeare_char/             # Default dataset (small, fast)
  tests/
    test_smoke.py                 # End-to-end smoke test
    test_training_run.py          # Unit test for TrainingRun machine
    test_data_pipeline.py         # Unit test for DataPipeline machine
```

## Why This Demo

1. **Real-world credible** — ML training orchestration is a genuine pain point
2. **Karpathy brand** — instant recognition, the "hello world" of ML training
3. **Forces 3+ new language features** — effects, persistence, logging
4. **Recursive narrative** — LLM generates state machines that train LLMs
5. **Visually compelling** — parallel training runs with live progress
6. **Incrementally buildable** — each phase adds one feature, each phase is demoable
7. **Showcases the full Orca stack** — parser, verifier, compiler, runtime, LLM skills

## Open Questions

- [ ] Should we vendor nanoGPT or depend on it as a git submodule?
- [ ] Character-level Shakespeare only, or also support BPE/openwebtext for longer demos?
- [ ] How deep should HellaSwag integration go? (requires build-nanogpt's hellaswag.py)
- [ ] Should the `## effects` section support nested/complex types or just primitives?
- [ ] Should persistence be a language feature or a runtime-only concern?
- [ ] How does the `## logging` section interact with existing event bus subscriptions?
- [ ] Should long-running effects be a distinct concept or just effects with a `progress` callback convention?
- [ ] For Phase 8 (LLM refinement): what context from the audit log is most useful for the refinement prompt?
