"""Action handlers for model training, configuration, and hyperparameter search."""

import asyncio
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

from rich.table import Table
from rich import box

from nanolab.display.terminal import console


# ── Inline progress bar (unicode blocks, parallel-safe) ────────────────────────

_BAR_WIDTH = 24
_BAR_FILL  = "█"
_BAR_EMPTY = "░"

def _bar(pct: float) -> str:
    filled = round(pct / 100 * _BAR_WIDTH)
    return _BAR_FILL * filled + _BAR_EMPTY * (_BAR_WIDTH - filled)


# ── Handlers ───────────────────────────────────────────────────────────────────

async def configure_trials(ctx: dict[str, Any], evt: Any = None) -> dict[str, Any]:
    """
    Set up two trial hyperparameter configurations for HyperSearch.

    Trial A: smaller/faster model (fewer layers, higher LR)
    Trial B: larger/regularized model (more layers, lower LR, dropout)

    Trial max_iters is capped at 20% of the full run to keep search fast.
    """
    run_dir   = Path(ctx["run_dir"])
    trial_max = max(50, int(ctx.get("max_iters", 500) * 0.2))

    result: dict[str, Any] = {
        "trial_a_n_layer":   4,
        "trial_a_n_head":    4,
        "trial_a_n_embd":    256,
        "trial_a_dropout":   0.0,
        "trial_a_lr":        6e-4,
        "trial_a_run_dir":   str(run_dir / "trial_a"),
        "trial_a_max_iters": trial_max,
        "trial_b_n_layer":   6,
        "trial_b_n_head":    6,
        "trial_b_n_embd":    384,
        "trial_b_dropout":   0.1,
        "trial_b_lr":        3e-4,
        "trial_b_run_dir":   str(run_dir / "trial_b"),
        "trial_b_max_iters": trial_max,
    }

    table = Table(box=box.SIMPLE, show_header=True, padding=(0, 2),
                  show_edge=False, header_style="bold dim white")
    table.add_column("Trial",    style="label",      min_width=8)
    table.add_column("n_layer",  style="metric.val", justify="right")
    table.add_column("n_embd",   style="metric.val", justify="right")
    table.add_column("lr",       style="metric.val", justify="right")
    table.add_column("dropout",  style="metric.val", justify="right")
    table.add_column("iters",    style="metric.val", justify="right")

    table.add_row(
        "[trial.a]Trial A[/trial.a]",
        str(result["trial_a_n_layer"]),
        str(result["trial_a_n_embd"]),
        f"{result['trial_a_lr']:.0e}",
        str(result["trial_a_dropout"]),
        str(trial_max),
    )
    table.add_row(
        "[trial.b]Trial B[/trial.b]",
        str(result["trial_b_n_layer"]),
        str(result["trial_b_n_embd"]),
        f"{result['trial_b_lr']:.0e}",
        str(result["trial_b_dropout"]),
        str(trial_max),
    )
    console.print(table)

    return result


async def compare_trials(ctx: dict[str, Any], evt: Any = None) -> dict[str, Any]:
    """
    Compare the two trial validation losses and write the winning
    hyperparameter config back to context.
    """
    a_loss = ctx.get("trial_a_val_loss", 999.0)
    b_loss = ctx.get("trial_b_val_loss", 999.0)

    a_wins = a_loss <= b_loss
    winner = "A" if a_wins else "B"
    winner_loss  = min(a_loss, b_loss)
    loser_loss   = max(a_loss, b_loss)

    if a_wins:
        result: dict[str, Any] = {
            "n_layer":       ctx.get("trial_a_n_layer", 4),
            "n_head":        ctx.get("trial_a_n_head", 4),
            "n_embd":        ctx.get("trial_a_n_embd", 256),
            "dropout":       ctx.get("trial_a_dropout", 0.0),
            "learning_rate": ctx.get("trial_a_lr", 6e-4),
        }
    else:
        result = {
            "n_layer":       ctx.get("trial_b_n_layer", 6),
            "n_head":        ctx.get("trial_b_n_head", 6),
            "n_embd":        ctx.get("trial_b_n_embd", 384),
            "dropout":       ctx.get("trial_b_dropout", 0.1),
            "learning_rate": ctx.get("trial_b_lr", 3e-4),
        }

    # Comparison table
    table = Table(box=box.SIMPLE, show_header=True, padding=(0, 2),
                  show_edge=False, header_style="bold dim white")
    table.add_column("Trial",    style="label", min_width=10)
    table.add_column("val_loss", style="metric.val", justify="right")
    table.add_column("",         justify="left")

    a_style = "metric.good" if a_wins else "dim white"
    b_style = "metric.good" if not a_wins else "dim white"

    table.add_row(
        "[trial.a]Trial A[/trial.a]",
        f"[{a_style}]{a_loss:.4f}[/{a_style}]",
        "[metric.good]← winner[/metric.good]" if a_wins else "",
    )
    table.add_row(
        "[trial.b]Trial B[/trial.b]",
        f"[{b_style}]{b_loss:.4f}[/{b_style}]",
        "[metric.good]← winner[/metric.good]" if not a_wins else "",
    )
    console.print(table)
    console.print(
        f"     [label]selected Trial {winner}[/label]  "
        f"[metric.good]{winner_loss:.4f}[/metric.good]"
        f"  [label]<[/label]  [dim]{loser_loss:.4f}[/dim]  "
        f"[label]·  n_layer=[/label][metric.val]{result['n_layer']}[/metric.val]"
        f"  [label]n_embd=[/label][metric.val]{result['n_embd']}[/metric.val]"
        f"  [label]lr=[/label][metric.val]{result['learning_rate']:.0e}[/metric.val]"
    )

    return result


async def configure_run(ctx: dict[str, Any], evt: Any = None) -> dict[str, Any]:
    """Write a run-specific config file with hyperparameters from context."""
    run_dir = Path(ctx["run_dir"])
    run_dir.mkdir(parents=True, exist_ok=True)

    config = {
        "out_dir":      str(run_dir / "checkpoints"),
        "dataset":      ctx.get("dataset", "shakespeare_char"),
        "max_iters":    ctx.get("max_iters", 500),
        "eval_interval": min(250, ctx.get("max_iters", 500) // 4 or 50),
        "eval_iters":   100,
        "log_interval": 10,
        "always_save_checkpoint": True,
        "n_layer":      ctx.get("n_layer", 6),
        "n_head":       ctx.get("n_head", 6),
        "n_embd":       ctx.get("n_embd", 384),
        "dropout":      ctx.get("dropout", 0.2),
        "bias":         False,
        "learning_rate": ctx.get("learning_rate", 1e-3),
        "batch_size":   ctx.get("batch_size", 64),
        "block_size":   ctx.get("block_size", 256),
        "gradient_accumulation_steps": 1,
        "beta2":        0.99,
        "warmup_iters": 100,
        "lr_decay_iters": ctx.get("max_iters", 500),
        "min_lr":       ctx.get("learning_rate", 1e-3) / 10,
        "device":       ctx.get("device", "cpu"),
        "dtype":        "float32",
        "compile":      False,
        "wandb_log":    False,
    }

    ckpt_path = Path(config["out_dir"]) / "ckpt.pt"
    config["init_from"] = "resume" if ckpt_path.exists() else "scratch"

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
    (run_dir / "config.json").write_text(json.dumps(config, indent=2) + "\n")
    (run_dir / "checkpoints").mkdir(exist_ok=True)

    console.print(
        f"     [label]config[/label]  [dim]{config_path}[/dim]  "
        f"[label]·  n_layer=[/label][metric.val]{config['n_layer']}[/metric.val]"
        f"  [label]n_embd=[/label][metric.val]{config['n_embd']}[/metric.val]"
        f"  [label]lr=[/label][metric.val]{config['learning_rate']:.0e}[/metric.val]"
        f"  [label]iters=[/label][metric.val]{config['max_iters']}[/metric.val]"
    )

    return {"config_path": str(config_path)}


async def run_training(ctx: dict[str, Any], evt: Any = None) -> dict[str, Any]:
    """Run nanoGPT train.py as a subprocess, streaming progress."""
    vendor_dir  = Path(ctx["vendor_dir"])
    run_dir     = Path(ctx["run_dir"])
    config_path = ctx.get("config_path", str(run_dir / "config.py"))
    max_iters   = ctx.get("max_iters", 500)

    cmd = [sys.executable, str(vendor_dir / "train.py"), str(config_path)]

    console.print(
        f"     [label]launch[/label]  [dim]{vendor_dir / 'train.py'}  {Path(config_path).name}[/dim]"
    )
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
        "val_loss":   0.0,
        "best_val_loss": 999.0,
        "iter_num":   0,
    }

    eval_pattern       = re.compile(r"step (\d+): train loss ([\d.]+), val loss ([\d.]+)")
    iter_pattern       = re.compile(r"iter (\d+): loss ([\d.]+), time ([\d.]+)ms")
    checkpoint_pattern = re.compile(r"saving checkpoint to")

    last_report_iter = -1

    assert proc.stdout is not None
    async for raw_line in proc.stdout:
        line = raw_line.decode().strip()
        if not line:
            continue

        # Eval checkpoint: "step N: train loss X, val loss Y"
        m = eval_pattern.search(line)
        if m:
            step  = int(m.group(1))
            train = float(m.group(2))
            val   = float(m.group(3))
            result["iter_num"]   = step
            result["train_loss"] = train
            result["val_loss"]   = val
            if val < result["best_val_loss"]:
                result["best_val_loss"] = val
            pct     = min(100.0, step / max_iters * 100) if max_iters > 0 else 0.0
            elapsed = time.time() - start_time
            console.print(
                f"     [dim]{_bar(pct)}[/dim]  "
                f"[metric.val]{step:>5}[/metric.val][label]/{max_iters}[/label]  "
                f"[label]val=[/label][metric.good]{val:.4f}[/metric.good]  "
                f"[label]train=[/label][metric.val]{train:.4f}[/metric.val]  "
                f"[label]({elapsed:.0f}s)[/label]"
            )
            continue

        # Iteration line: "iter N: loss X, time Yms"
        m = iter_pattern.search(line)
        if m:
            step = int(m.group(1))
            loss = float(m.group(2))
            result["iter_num"]   = step
            result["train_loss"] = loss
            report_interval = max(50, max_iters // 10)
            if step - last_report_iter >= report_interval:
                pct     = min(100.0, step / max_iters * 100) if max_iters > 0 else 0.0
                elapsed = time.time() - start_time
                console.print(
                    f"     [dim]{_bar(pct)}[/dim]  "
                    f"[metric.val]{step:>5}[/metric.val][label]/{max_iters}[/label]  "
                    f"[label]loss=[/label][metric.val]{loss:.4f}[/metric.val]  "
                    f"[label]({elapsed:.0f}s)[/label]"
                )
                last_report_iter = step
            continue

        if checkpoint_pattern.search(line):
            console.print(f"     [state.ok]↓[/state.ok]  [label]checkpoint saved[/label]")
            continue

        if any(kw in line for kw in ["number of parameters", "Initializing", "tokens per"]):
            console.print(f"     [dim]{line}[/dim]")

    await proc.wait()
    elapsed = time.time() - start_time

    if proc.returncode != 0:
        result["error_message"] = f"Training failed with exit code {proc.returncode}"
        console.print(
            f"     [state.err]✗[/state.err]  [label]training failed  "
            f"(exit {proc.returncode}  ·  {elapsed:.0f}s)[/label]"
        )
    else:
        result["iter_num"] = max_iters
        pct = 100.0
        console.print(
            f"     [dim]{_bar(pct)}[/dim]  "
            f"[metric.val]{max_iters}[/metric.val][label]/{max_iters}[/label]  "
            f"[label]done[/label]  "
            f"[label]best val=[/label][metric.good]{result['best_val_loss']:.4f}[/metric.good]  "
            f"[label]({elapsed:.0f}s)[/label]"
        )

    return result
