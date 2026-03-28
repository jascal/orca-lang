"""Action handlers for model training, configuration, and hyperparameter search."""

import os
import sys
import json
import asyncio
import re
import time
from pathlib import Path
from typing import Any


async def configure_trials(ctx: dict[str, Any], evt: Any = None) -> dict[str, Any]:
    """
    Set up two trial hyperparameter configurations for HyperSearch.

    Trial A: smaller/faster model (fewer layers, higher LR)
    Trial B: larger/regularized model (more layers, lower LR, dropout)

    Trial max_iters is capped at 20% of the full run to keep search fast.
    """
    run_dir = Path(ctx["run_dir"])
    trial_max = max(50, int(ctx.get("max_iters", 500) * 0.2))

    result: dict[str, Any] = {
        # Trial A — smaller, faster, higher LR
        "trial_a_n_layer": 4,
        "trial_a_n_head": 4,
        "trial_a_n_embd": 256,
        "trial_a_dropout": 0.0,
        "trial_a_lr": 6e-4,
        "trial_a_run_dir": str(run_dir / "trial_a"),
        "trial_a_max_iters": trial_max,
        # Trial B — larger, regularized, lower LR
        "trial_b_n_layer": 6,
        "trial_b_n_head": 6,
        "trial_b_n_embd": 384,
        "trial_b_dropout": 0.1,
        "trial_b_lr": 3e-4,
        "trial_b_run_dir": str(run_dir / "trial_b"),
        "trial_b_max_iters": trial_max,
    }

    print(f"  Trial A: n_layer={result['trial_a_n_layer']}, "
          f"n_embd={result['trial_a_n_embd']}, lr={result['trial_a_lr']:.0e}")
    print(f"  Trial B: n_layer={result['trial_b_n_layer']}, "
          f"n_embd={result['trial_b_n_embd']}, lr={result['trial_b_lr']:.0e}")
    print(f"  Trial iters: {trial_max} each")

    return result


async def compare_trials(ctx: dict[str, Any], evt: Any = None) -> dict[str, Any]:
    """
    Compare the two trial validation losses and write the winning
    hyperparameter config back to context.

    The winning n_layer/n_head/n_embd/dropout/learning_rate values replace
    the defaults so that the subsequent full TrainingRun inherits them.
    """
    a_loss = ctx.get("trial_a_val_loss", 999.0)
    b_loss = ctx.get("trial_b_val_loss", 999.0)

    print(f"  Trial A val_loss: {a_loss:.4f}")
    print(f"  Trial B val_loss: {b_loss:.4f}")

    if a_loss <= b_loss:
        winner = "A"
        result: dict[str, Any] = {
            "n_layer": ctx.get("trial_a_n_layer", 4),
            "n_head": ctx.get("trial_a_n_head", 4),
            "n_embd": ctx.get("trial_a_n_embd", 256),
            "dropout": ctx.get("trial_a_dropout", 0.0),
            "learning_rate": ctx.get("trial_a_lr", 6e-4),
        }
    else:
        winner = "B"
        result = {
            "n_layer": ctx.get("trial_b_n_layer", 6),
            "n_head": ctx.get("trial_b_n_head", 6),
            "n_embd": ctx.get("trial_b_n_embd", 384),
            "dropout": ctx.get("trial_b_dropout", 0.1),
            "learning_rate": ctx.get("trial_b_lr", 3e-4),
        }

    print(f"  Winner: Trial {winner} "
          f"(val_loss={min(a_loss, b_loss):.4f} < "
          f"{max(a_loss, b_loss):.4f})")
    print(f"  Winning config: n_layer={result['n_layer']}, "
          f"n_embd={result['n_embd']}, lr={result['learning_rate']:.0e}")

    return result


async def configure_run(ctx: dict[str, Any], evt: Any = None) -> dict[str, Any]:
    """Write a run-specific config file with hyperparameters from context."""
    run_dir = Path(ctx["run_dir"])
    run_dir.mkdir(parents=True, exist_ok=True)

    # Build config from context
    config = {
        "out_dir": str(run_dir / "checkpoints"),
        "dataset": ctx.get("dataset", "shakespeare_char"),
        "max_iters": ctx.get("max_iters", 500),
        "eval_interval": min(250, ctx.get("max_iters", 500) // 4 or 50),
        "eval_iters": 100,  # fewer eval iters for speed
        "log_interval": 10,
        "always_save_checkpoint": True,
        # Model
        "n_layer": ctx.get("n_layer", 6),
        "n_head": ctx.get("n_head", 6),
        "n_embd": ctx.get("n_embd", 384),
        "dropout": ctx.get("dropout", 0.2),
        "bias": False,
        # Optimizer
        "learning_rate": ctx.get("learning_rate", 1e-3),
        "batch_size": ctx.get("batch_size", 64),
        "block_size": ctx.get("block_size", 256),
        "gradient_accumulation_steps": 1,
        "beta2": 0.99,
        "warmup_iters": 100,
        "lr_decay_iters": ctx.get("max_iters", 500),
        "min_lr": ctx.get("learning_rate", 1e-3) / 10,
        # System
        "device": ctx.get("device", "cpu"),
        "dtype": "float32",  # safe default for cpu/mps
        "compile": False,  # don't compile on cpu/mps
        "wandb_log": False,
    }

    # Resume from existing checkpoint if one is present
    ckpt_path = Path(config["out_dir"]) / "ckpt.pt"
    config["init_from"] = "resume" if ckpt_path.exists() else "scratch"

    # Write config file
    config_path = run_dir / "config.py"
    lines = []
    for k, v in config.items():
        if isinstance(v, str):
            lines.append(f"{k} = '{v}'")
        elif isinstance(v, bool):
            lines.append(f"{k} = {v}")
        elif isinstance(v, (int, float)):
            lines.append(f"{k} = {v}")
    config_path.write_text("\n".join(lines) + "\n")

    # Also save as JSON for our own reference
    (run_dir / "config.json").write_text(json.dumps(config, indent=2) + "\n")

    (run_dir / "checkpoints").mkdir(exist_ok=True)

    print(f"  Config written to {config_path}")
    print(f"  Model: n_layer={config['n_layer']}, n_head={config['n_head']}, "
          f"n_embd={config['n_embd']}, dropout={config['dropout']}")
    print(f"  Training: max_iters={config['max_iters']}, lr={config['learning_rate']}, "
          f"batch_size={config['batch_size']}, block_size={config['block_size']}")
    print(f"  Device: {config['device']}, dtype={config['dtype']}")

    return {"config_path": str(config_path)}


async def run_training(ctx: dict[str, Any], evt: Any = None) -> dict[str, Any]:
    """Run nanoGPT train.py as a subprocess, streaming progress."""
    vendor_dir = Path(ctx["vendor_dir"])
    run_dir = Path(ctx["run_dir"])
    config_path = ctx.get("config_path", str(run_dir / "config.py"))

    train_script = vendor_dir / "train.py"

    cmd = [
        sys.executable, str(train_script),
        str(config_path),
    ]

    print(f"  Launching: {' '.join(cmd[-2:])}")
    start_time = time.time()

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=str(vendor_dir),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
    )

    result: dict[str, Any] = {
        "train_loss": 0.0,
        "val_loss": 0.0,
        "best_val_loss": 999.0,
        "iter_num": 0,
    }

    # Regex patterns for nanoGPT output
    eval_pattern = re.compile(
        r"step (\d+): train loss ([\d.]+), val loss ([\d.]+)"
    )
    iter_pattern = re.compile(
        r"iter (\d+): loss ([\d.]+), time ([\d.]+)ms"
    )
    checkpoint_pattern = re.compile(r"saving checkpoint to")

    last_report_iter = -1
    max_iters = ctx.get("max_iters", 500)

    assert proc.stdout is not None
    async for raw_line in proc.stdout:
        line = raw_line.decode().strip()
        if not line:
            continue

        # Parse eval lines: "step N: train loss X.XXXX, val loss Y.YYYY"
        m = eval_pattern.search(line)
        if m:
            step, train_loss, val_loss = int(m.group(1)), float(m.group(2)), float(m.group(3))
            result["iter_num"] = step
            result["train_loss"] = train_loss
            result["val_loss"] = val_loss
            if val_loss < result["best_val_loss"]:
                result["best_val_loss"] = val_loss
            elapsed = time.time() - start_time
            pct = min(100, step / max_iters * 100) if max_iters > 0 else 0
            print(f"  [{pct:5.1f}%] step {step}: "
                  f"train_loss={train_loss:.4f}, val_loss={val_loss:.4f} "
                  f"({elapsed:.0f}s)")
            continue

        # Parse iter lines: "iter N: loss X.XXXX, time Y.YYms"
        m = iter_pattern.search(line)
        if m:
            step = int(m.group(1))
            loss = float(m.group(2))
            result["iter_num"] = step
            result["train_loss"] = loss
            # Print progress every ~10% or every 50 iters
            report_interval = max(50, max_iters // 10)
            if step - last_report_iter >= report_interval:
                elapsed = time.time() - start_time
                pct = min(100, step / max_iters * 100) if max_iters > 0 else 0
                print(f"  [{pct:5.1f}%] iter {step}: loss={loss:.4f} ({elapsed:.0f}s)")
                last_report_iter = step
            continue

        # Checkpoint saves
        if checkpoint_pattern.search(line):
            print(f"  Checkpoint saved")
            continue

        # Other interesting lines (model init, etc.)
        if any(kw in line for kw in ["number of parameters", "Initializing", "tokens per"]):
            print(f"  {line}")

    await proc.wait()
    elapsed = time.time() - start_time

    if proc.returncode != 0:
        result["error_message"] = f"Training failed with exit code {proc.returncode}"
        print(f"  Training FAILED (exit {proc.returncode}, {elapsed:.0f}s)")
    else:
        result["iter_num"] = max_iters
        print(f"  Training complete: {max_iters} iters in {elapsed:.0f}s")
        print(f"  Final: train_loss={result['train_loss']:.4f}, "
              f"val_loss={result['val_loss']:.4f}, "
              f"best_val_loss={result['best_val_loss']:.4f}")

    return result
