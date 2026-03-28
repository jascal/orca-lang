# orca-nanolab: Intelligent nanoGPT Training Orchestrator

> An LLM-generated state machine that orchestrates the training and tuning of another LLM — using Karpathy's nanoGPT as the training engine and Orca as the workflow brain.

## Overview

This demo uses Orca state machines to orchestrate nanoGPT training runs: data preparation, parallel hyperparameter search, adaptive training, evaluation, full audit logging, and LLM-powered workflow refinement. It serves dual purpose as both a compelling real-world demo and a **forcing function** that drove several production features into the Orca framework.

### The Recursive Narrative

Claude generates Orca machines that manage GPT-2 training runs, evaluate results, adapt hyperparameters, and persist the full audit trail. After a run, the audit log is fed back to Claude via `--refine` to produce an improved `.orca.md` — the workflow improves itself.

## Why nanoGPT

| Property | Why it matters |
|----------|---------------|
| **~300 lines of training code** | Simple enough to wrap, complex enough to orchestrate |
| **Pure Python** | Matches `orca-runtime-python` |
| **Character-level Shakespeare** | Trains in minutes on CPU — fast iteration for demos |
| **Rich hyperparameter space** | 20+ tunable knobs (lr, n_layer, n_head, dropout, batch_size…) |
| **Checkpoint/resume built in** | Natural fit for snapshot/restore |
| **Most recognizable ML training repo** | Instant credibility |

## Multi-Machine Architecture

```
TrainingLab (coordinator)
  ├── DataPipeline    — check data, download + tokenize if missing
  ├── HyperSearch     — two parallel TrainingRun trials, select winner
  │     ├── region trial_a  →  invokes TrainingRun (smaller, faster config)
  │     └── region trial_b  →  invokes TrainingRun (larger, regularized config)
  ├── TrainingRun     — write config, run train.py subprocess, stream progress
  └── Evaluator       — estimate final loss, generate Shakespeare samples
```

All five machines live in a single `orca/training-lab.orca.md` file, separated by `---`.

### TrainingLab context (selected fields)

| Field | Purpose |
|-------|---------|
| `vendor_dir` / `run_dir` | Paths injected at runtime |
| `max_iters` | Training budget (default 500) |
| `device` | cpu / cuda / mps |
| `n_layer`, `n_head`, `n_embd`, `dropout`, `learning_rate` | Updated to winning config after HyperSearch |
| `best_val_loss` | Tracks best checkpoint across all child runs |
| `sample_text` | Final generated Shakespeare excerpt |
| `error_message` | Non-empty triggers ERROR transition |

## Framework Features Driven by This Demo

This demo required four new production features that are now part of the framework:

### 1. `## effects` Section
Declares named effects with typed input/output schemas inside `.orca.md`. Implemented in `runtime-python` as `EffectDef` — parseable, introspectable, and displayed by the Python parser. Used throughout `training-lab.orca.md` to document `FileCheck`, `ShellExec`, `ConfigWrite`, `TrainSubproc`, `EstimateLoss`, and `TextGenerate`.

### 2. Pluggable Persistence (`PersistenceAdapter`)
Protocol-based adapter injected at the driver/pipeline level. `FilePersistence` (bundled in `runtime-python`) uses atomic write-then-rename for crash safety. `OrcaMachine.resume()` cold-boots from a snapshot without re-running `on_entry` handlers — distinct from `restore()` (live-machine primitive). Enable via `--persist` or pass `FilePersistence` to `run_pipeline`.

### 3. Structured Audit Logging (`LogSink`)
Protocol with `write(entry)` / `close()`. Bundled sinks: `FileSink` (JSONL, append-safe for resume), `ConsoleSink` (`[HH:MM:SS] Machine  from → to`), `MultiSink` (fan-out). One entry per transition across all machines with `context_delta`. Injected via `log_sink=` parameter of `run_pipeline`.

### 4. LLM Workflow Refinement (Phase 8)
After a run, `nanolab.refine` distils the audit log and final context into a structured run summary, builds a targeted prompt (trial comparison table, convergence curve, transition sequence), calls Claude, and writes a `training-lab-refined-<run_id>.orca.md`. Enable via `--refine --api-key $ANTHROPIC_API_KEY`.

## Demo Output

```
──────────────── 🔬 orca-nanolab · nanoGPT Training Orchestrator ────────────────

📂  DataPipeline
     ✓  data found  924,432 train tokens  ·  vocab = 65

🔍  HyperSearch
      Trial    n_layer  n_embd       lr  dropout  iters
     ──────────────────────────────────────────────────
     Trial A       4      256    6e-04      0.0    100
     Trial B       6      384    3e-04      0.1    100

     ░░░░░░░░░░░░░░░░░░░░░░░░    50/100  val=2.3102  train=2.3811  (4s)
     ████████████████████████   100/100  done  best val=2.3102  (8s)

      Trial A   2.3102  ← winner
      Trial B   2.3841

     selected Trial A  2.3102  <  2.3841  ·  n_layer=4  n_embd=256  lr=6e-04

🏋️   TrainingRun
     ████████████████████░░░░   400/500  val=2.2981  train=2.2543  (31s)
     ████████████████████████   500/500  done  best val=2.2341  (41s)

📊  Evaluator
     ✓  train=2.2543  val=2.2981
     ✓  3 samples  ·  412 chars
       ROMEO: What light through yonder window breaks…

╭──────────────────────── ✅  Training Complete ─────────────────────────╮
│                                                                        │
│   Dataset          shakespeare_char                                    │
│   Corpus           1,003,854 chars  ·  vocab = 65                     │
│   Best config      n_layer=4 · n_head=4 · n_embd=256 · lr=6e-04      │
│   Final loss       train = 2.2543  ·  val = 2.2981                   │
│   Best val loss    2.2341                                              │
│   Iterations       500 / 500                                           │
│   Total time       45s                                                 │
│                                                                        │
│  ╭─ Generated sample ──────────────────────────────────────────────╮  │
│  │  ROMEO: What light through yonder window breaks,                │  │
│  │  It is the east, and Juliet is the sun.                         │  │
│  ╰─────────────────────────────────────────────────────────────────╯  │
╰────────────────────── 📂 runs/20260327-103045 ─────────────────────────╯
```

## Usage

```bash
# Quick test (100 iters, no torch required for unit tests)
python -m nanolab --max-iters 100

# Full run with persistence + logging
python -m nanolab --max-iters 500 --persist --log runs/exp-001/audit.jsonl --run-id exp-001

# Full run + Phase 8 refinement
python -m nanolab --max-iters 500 --refine --api-key $ANTHROPIC_API_KEY

# Resume a crashed run
python -m nanolab --run-id exp-001 --run-dir runs/exp-001 --persist

# GPU run
python -m nanolab --device cuda --max-iters 2000
```

## Implementation Status

All planned phases are complete.

| Phase | What | Framework Feature | Status |
|-------|------|-------------------|--------|
| **0** | Vendor nanoGPT `train.py` / `model.py` / `sample.py` | — | ✅ |
| **1** | Single `TrainingRun` machine — subprocess effect | Long-running subprocess effects | ✅ |
| **2** | `## effects` section in language + Python parser | `EffectDef`, effects table in `.orca.md` | ✅ |
| **3** | `DataPipeline` + `Evaluator` child machines | Machine invocation in Python runtime | ✅ |
| **4** | `HyperSearch` with parallel trials | Parallel regions + `invoke:` in regions | ✅ |
| **5** | Pluggable persistence, crash-recovery resume | `PersistenceAdapter`, `FilePersistence`, `OrcaMachine.resume()` | ✅ |
| **6** | Structured audit logging | `LogSink`, `FileSink`, `ConsoleSink`, `MultiSink` | ✅ |
| **7** | Rich terminal display | — | ✅ |
| **8** | LLM workflow refinement | `nanolab.refine`, `--refine` CLI flag | ✅ |

## Package Structure

```
packages/demo-nanolab/
  pyproject.toml                    # deps: orca-runtime-python, rich; optional: anthropic (llm extra)
  orca/
    training-lab.orca.md            # All 5 machines: TrainingLab, DataPipeline, HyperSearch,
                                    # TrainingRun, Evaluator — separated by ---
  nanolab/
    __init__.py
    __main__.py                     # CLI: --max-iters, --device, --persist, --log, --refine, --api-key
    driver.py                       # Recursive multi-machine driver, context merging, parallel dispatch
    refine.py                       # Phase 8: audit log parsing, prompt construction, call_claude
    handlers/
      data_pipeline.py              # check_data, prepare_data
      training.py                   # configure_run, run_training, configure_trials, compare_trials
      evaluation.py                 # evaluate_model, generate_samples
    display/
      terminal.py                   # Rich console, print_banner/transition/summary/refine_result
    vendor/
      train.py                      # Vendored from nanoGPT
      model.py
      sample.py
      configurator.py
      data/shakespeare_char/        # prepare.py + dataset cache
  tests/
    test_smoke.py                   # 25 machine parsing + pipeline tests (no torch required)
    test_refine.py                  # 22 refinement tests (Anthropic SDK mocked)
```

## Open Questions

These were open during design; answers recorded here for reference.

| Question | Resolution |
|----------|------------|
| Vendor nanoGPT or git submodule? | Vendored — simpler for a self-contained demo |
| Dataset scope? | Shakespeare char only — trains in minutes on CPU, good for demos |
| `## effects` — nested types? | Primitives only for now; typed via the table `Type` column as documentation |
| Persistence: language feature or runtime? | Runtime-level `PersistenceAdapter` Protocol injected at driver — keeps language clean |
| `## logging` vs event bus? | Separate `LogSink` protocol; driver writes entries after each `machine.send()` call |
| Long-running effects: distinct concept? | Subprocess with streaming stdout; progress parsed and printed inline, no separate effect type needed |
| Phase 8 refinement: what context is most useful? | Trial A/B val_loss comparison + full TrainingLab transition sequence + final metrics — enough for Claude to identify what to improve |
