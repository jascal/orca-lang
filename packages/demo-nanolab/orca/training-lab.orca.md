# machine TrainingLab

> Orchestrates the full nanoGPT training pipeline: data preparation,
> parallel hyperparameter search, best-config training, and evaluation.

## context

| Field         | Type   | Default            |
|---------------|--------|--------------------|
| vendor_dir    | string | ""                 |
| run_dir       | string | ""                 |
| dataset       | string | "shakespeare_char" |
| max_iters     | number | 500                |
| device        | string | "cpu"              |
| n_layer       | number | 6                  |
| n_head        | number | 6                  |
| n_embd        | number | 384                |
| dropout       | number | 0.2                |
| learning_rate | number | 0.001              |
| batch_size    | number | 64                 |
| block_size    | number | 256                |
| data_exists   | bool   | false              |
| data_chars    | number | 0                  |
| vocab_size    | number | 0                  |
| train_tokens  | number | 0                  |
| val_tokens    | number | 0                  |
| config_path   | string | ""                 |
| train_loss    | number | 0                  |
| val_loss      | number | 0                  |
| best_val_loss | number | 999                |
| iter_num      | number | 0                  |
| sample_text   | string | ""                 |
| error_message | string | ""                 |

## events

- START
- DATA_READY
- HYPER_DONE
- TRAINING_DONE
- EVAL_DONE
- ERROR

## state idle [initial]
> Waiting to begin the training pipeline.

## state data_prep
> Invokes DataPipeline to check and prepare the training dataset.
- invoke: DataPipeline
- on_done: DATA_READY
- on_error: ERROR

## state hyper_search
> Invokes HyperSearch to run parallel trials and select the best config.
- invoke: HyperSearch
- on_done: HYPER_DONE
- on_error: ERROR

## state training
> Invokes TrainingRun using the winning hyperparameter config.
- invoke: TrainingRun
- on_done: TRAINING_DONE
- on_error: ERROR

## state evaluating
> Invokes Evaluator to assess model quality and generate samples.
- invoke: Evaluator
- on_done: EVAL_DONE
- on_error: ERROR

## state completed [final]
> Training pipeline finished successfully.

## state failed [final]
> Pipeline failed with an error.

## transitions

| Source      | Event         | Target      |
|-------------|---------------|-------------|
| idle        | START         | data_prep   |
| data_prep   | DATA_READY    | hyper_search|
| hyper_search| HYPER_DONE    | training    |
| training    | TRAINING_DONE | evaluating  |
| evaluating  | EVAL_DONE     | completed   |
| data_prep   | ERROR         | failed      |
| hyper_search| ERROR         | failed      |
| training    | ERROR         | failed      |
| evaluating  | ERROR         | failed      |

## effects

| Name         | Input                                                          | Output                                                   |
|--------------|----------------------------------------------------------------|----------------------------------------------------------|
| FileCheck    | `{ path: string }`                                             | `{ exists: bool }`                                       |
| ShellExec    | `{ cmd: string, cwd: string }`                                 | `{ exit_code: int, stdout: string }`                     |
| ConfigWrite  | `{ run_dir: string, params: TrainConfig }`                     | `{ config_path: string }`                                |
| TrainSubproc | `{ train_script: string, config_path: string }`                | `{ iter_num: int, train_loss: float, val_loss: float }`  |
| EstimateLoss | `{ checkpoint_dir: string, config_path: string }`              | `{ train_loss: float, val_loss: float }`                 |
| TextGenerate | `{ checkpoint_dir: string, device: string, num_samples: int }` | `{ samples: string[], sample_text: string }`             |

## persistence

| Strategy | Location              | On         | Scope       |
|----------|-----------------------|------------|-------------|
| file     | `{base_dir}/{run_id}` | transition | TrainingLab |

Only the top-level TrainingLab machine is checkpointed. Child machines
(DataPipeline, HyperSearch, TrainingRun, Evaluator) are re-driven from the
restored context, which already contains their merged outputs. The nanoGPT
`train.py` handles its own model checkpointing independently — configure_run
detects an existing `ckpt.pt` and sets `init_from = resume` automatically.

## logging

| Sink        | Format                                                                  |
|-------------|-------------------------------------------------------------------------|
| FileSink    | JSONL — one entry per transition, append-safe for concurrent runs       |
| ConsoleSink | `[HH:MM:SS] Machine  from → to  (EVENT)  key=val` — human-readable     |
| MultiSink   | Fan-out — write to multiple sinks simultaneously                        |

One log entry is written per transition across all machines (TrainingLab and
every invoked child). Each entry includes: `ts`, `run_id`, `machine`, `event`,
`from`, `to`, and `context_delta` (only fields that changed in that step).
Inject a sink via the `log_sink` parameter of `run_pipeline`.

## refinement

After a run completes, `nanolab.refine.refine_workflow()` feeds the audit log
and final context back to Claude to produce an improved workflow definition.

```
python -m nanolab --refine --log runs/<id>/audit.jsonl --api-key $ANTHROPIC_API_KEY
```

The refinement prompt includes:
- The complete current `.orca.md` (all 5 machines)
- HyperSearch trial comparison table (A vs B val_loss, config details)
- Full training run metrics (final/best val_loss, convergence eval count)
- TrainingLab transition sequence extracted from the audit log

Claude returns a revised `.orca.md` saved as
`training-lab-refined-<run_id>.orca.md` alongside the original. The recursive
narrative: the Orca machine that orchestrated training now rewrites itself for
the next run — adjusting hyperparameter defaults, trial diversity, training
budget, or search strategy based on what it observed.

---

# machine DataPipeline

> Checks whether the dataset binary files are present. Downloads and
> tokenizes them if not. Idempotent — skips download if data exists.

## context

| Field         | Type   | Default            |
|---------------|--------|--------------------|
| vendor_dir    | string | ""                 |
| dataset       | string | "shakespeare_char" |
| data_exists   | bool   | false              |
| data_chars    | number | 0                  |
| vocab_size    | number | 0                  |
| train_tokens  | number | 0                  |
| val_tokens    | number | 0                  |
| error_message | string | ""                 |

## events

- DATA_EXISTS
- DATA_MISSING
- PREPARED
- ERROR

## state checking [initial]
> Check whether the dataset binary files are present.
- on_entry: check_data

## state downloading
> Download and tokenize the dataset via prepare.py.
- on_entry: prepare_data

## state ready [final]
> Dataset is available and ready for training.

## state error [final]
> Data preparation failed.

## transitions

| Source      | Event       | Target      |
|-------------|-------------|-------------|
| checking    | DATA_EXISTS | ready       |
| checking    | DATA_MISSING| downloading |
| downloading | PREPARED    | ready       |
| checking    | ERROR       | error       |
| downloading | ERROR       | error       |

---

# machine TrainingRun

> Writes the run config then runs nanoGPT train.py as a managed
> subprocess, streaming progress and capturing final metrics.

## context

| Field         | Type   | Default            |
|---------------|--------|--------------------|
| vendor_dir    | string | ""                 |
| run_dir       | string | ""                 |
| dataset       | string | "shakespeare_char" |
| max_iters     | number | 500                |
| device        | string | "cpu"              |
| n_layer       | number | 6                  |
| n_head        | number | 6                  |
| n_embd        | number | 384                |
| dropout       | number | 0.2                |
| learning_rate | number | 0.001              |
| batch_size    | number | 64                 |
| block_size    | number | 256                |
| config_path   | string | ""                 |
| train_loss    | number | 0                  |
| val_loss      | number | 0                  |
| best_val_loss | number | 999                |
| iter_num      | number | 0                  |
| error_message | string | ""                 |

## events

- CONFIG_DONE
- TRAINED
- ERROR

## state configuring [initial]
> Write the run-specific training configuration file.
- on_entry: configure_run

## state training
> Run nanoGPT train.py as a managed subprocess.
- on_entry: run_training

## state converged [final]
> Training completed successfully.

## state failed [final]
> Training failed or produced an error.

## transitions

| Source      | Event      | Target   |
|-------------|------------|----------|
| configuring | CONFIG_DONE| training |
| training    | TRAINED    | converged|
| configuring | ERROR      | failed   |
| training    | ERROR      | failed   |

---

# machine Evaluator

> Loads the trained checkpoint, estimates final loss metrics, and
> generates Shakespeare text samples.

## context

| Field         | Type   | Default |
|---------------|--------|---------|
| vendor_dir    | string | ""      |
| run_dir       | string | ""      |
| device        | string | "cpu"   |
| config_path   | string | ""      |
| train_loss    | number | 0       |
| val_loss      | number | 0       |
| sample_text   | string | ""      |
| error_message | string | ""      |

## events

- EVAL_DONE
- GENERATED
- ERROR

## state evaluating [initial]
> Load checkpoint and estimate final train/val loss.
- on_entry: evaluate_model

## state generating
> Generate Shakespeare text samples from the trained model.
- on_entry: generate_samples

## state done [final]
> Evaluation and sample generation complete.

## state error [final]
> Evaluation failed.

## transitions

| Source     | Event     | Target     |
|------------|-----------|------------|
| evaluating | EVAL_DONE | generating |
| generating | GENERATED | done       |
| evaluating | ERROR     | error      |
| generating | ERROR     | error      |

---

# machine HyperSearch

> Runs two TrainingRun trials in parallel with different hyperparameter
> configurations. When both complete, compares validation losses and
> writes the winning config back to context for the full training run.

## context

| Field            | Type   | Default            |
|------------------|--------|--------------------|
| vendor_dir       | string | ""                 |
| run_dir          | string | ""                 |
| dataset          | string | "shakespeare_char" |
| device           | string | "cpu"              |
| batch_size       | number | 64                 |
| block_size       | number | 256                |
| trial_a_n_layer  | number | 4                  |
| trial_a_n_head   | number | 4                  |
| trial_a_n_embd   | number | 256                |
| trial_a_dropout  | number | 0.0                |
| trial_a_lr       | number | 0.0006             |
| trial_a_run_dir  | string | ""                 |
| trial_a_max_iters| number | 100                |
| trial_a_val_loss | number | 999                |
| trial_b_n_layer  | number | 6                  |
| trial_b_n_head   | number | 6                  |
| trial_b_n_embd   | number | 384                |
| trial_b_dropout  | number | 0.1                |
| trial_b_lr       | number | 0.0003             |
| trial_b_run_dir  | string | ""                 |
| trial_b_max_iters| number | 100                |
| trial_b_val_loss | number | 999                |
| n_layer          | number | 6                  |
| n_head           | number | 6                  |
| n_embd           | number | 384                |
| dropout          | number | 0.0                |
| learning_rate    | number | 0.001              |
| error_message    | string | ""                 |

## events

- SEARCH_START
- TRIAL_A_DONE
- TRIAL_B_DONE
- SELECTED
- ERROR

## state configuring [initial]
> Set up trial A and B hyperparameter configurations.
- on_entry: configure_trials

## state running [parallel, sync: all-final]
> Run both trials concurrently; auto-transition when both finish.
- on_done: comparing

### region trial_a

#### state run_a [initial]
> Run TrainingRun with trial A (smaller, faster config).
- invoke: TrainingRun input: { n_layer: ctx.trial_a_n_layer, n_head: ctx.trial_a_n_head, n_embd: ctx.trial_a_n_embd, dropout: ctx.trial_a_dropout, learning_rate: ctx.trial_a_lr, run_dir: ctx.trial_a_run_dir, max_iters: ctx.trial_a_max_iters }
- on_done: TRIAL_A_DONE
- on_error: TRIAL_A_DONE

#### state done_a [final]
> Trial A complete.

### region trial_b

#### state run_b [initial]
> Run TrainingRun with trial B (larger, regularized config).
- invoke: TrainingRun input: { n_layer: ctx.trial_b_n_layer, n_head: ctx.trial_b_n_head, n_embd: ctx.trial_b_n_embd, dropout: ctx.trial_b_dropout, learning_rate: ctx.trial_b_lr, run_dir: ctx.trial_b_run_dir, max_iters: ctx.trial_b_max_iters }
- on_done: TRIAL_B_DONE
- on_error: TRIAL_B_DONE

#### state done_b [final]
> Trial B complete.

## state comparing
> Compare trial validation losses and select the winning configuration.
- on_entry: compare_trials

## state selected [final]
> Winning configuration selected and written to context.

## state exhausted [final]
> Search failed — no valid winner found.

## transitions

| Source      | Event        | Target   |
|-------------|--------------|----------|
| configuring | SEARCH_START | running  |
| run_a       | TRIAL_A_DONE | done_a   |
| run_b       | TRIAL_B_DONE | done_b   |
| comparing   | SELECTED     | selected |
| configuring | ERROR        | exhausted|
