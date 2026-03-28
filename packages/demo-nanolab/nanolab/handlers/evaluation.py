"""Action handlers for model evaluation and sample generation."""

import asyncio
import re
import sys
from pathlib import Path
from typing import Any

from nanolab.display.terminal import console


async def evaluate_model(ctx: dict[str, Any], evt: Any = None) -> dict[str, Any]:
    """Evaluate the trained model by running an eval-only pass."""
    vendor_dir     = Path(ctx["vendor_dir"])
    run_dir        = Path(ctx["run_dir"])
    checkpoint_dir = run_dir / "checkpoints"
    ckpt_path      = checkpoint_dir / "ckpt.pt"

    if not ckpt_path.exists():
        console.print(
            "     [state.err]✗[/state.err]  "
            "[label]no checkpoint — using training metrics[/label]"
        )
        return {}

    config_path = ctx.get("config_path", str(run_dir / "config.py"))

    cmd = [
        sys.executable, str(vendor_dir / "train.py"),
        str(config_path),
        "--eval_only=True",
        "--init_from=resume",
        f"--out_dir={checkpoint_dir}",
    ]

    console.print("     [label]evaluating checkpoint…[/label]")
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=str(vendor_dir),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    stdout, _ = await proc.communicate()
    output = stdout.decode() if stdout else ""

    result: dict[str, Any] = {}
    eval_pattern = re.compile(r"step \d+: train loss ([\d.]+), val loss ([\d.]+)")
    for line in output.split("\n"):
        m = eval_pattern.search(line)
        if m:
            result["train_loss"] = float(m.group(1))
            result["val_loss"]   = float(m.group(2))

    if result:
        console.print(
            f"     [state.ok]✓[/state.ok]  "
            f"[label]train=[/label][metric.val]{result['train_loss']:.4f}[/metric.val]  "
            f"[label]val=[/label][metric.good]{result['val_loss']:.4f}[/metric.good]"
        )

    return result


async def generate_samples(ctx: dict[str, Any], evt: Any = None) -> dict[str, Any]:
    """Generate text samples from the trained model using sample.py."""
    vendor_dir     = Path(ctx["vendor_dir"])
    run_dir        = Path(ctx["run_dir"])
    checkpoint_dir = run_dir / "checkpoints"
    ckpt_path      = checkpoint_dir / "ckpt.pt"

    if not ckpt_path.exists():
        console.print(
            "     [state.err]✗[/state.err]  "
            "[label]no checkpoint — skipping sample generation[/label]"
        )
        return {"sample_text": "(no checkpoint to sample from)"}

    device = ctx.get("device", "cpu")

    cmd = [
        sys.executable, str(vendor_dir / "sample.py"),
        f"--out_dir={checkpoint_dir}",
        f"--device={device}",
        "--dtype=float32",
        "--compile=False",
        "--num_samples=3",
        "--max_new_tokens=200",
        "--temperature=0.8",
        "--top_k=200",
        "--start=\n",
    ]

    console.print("     [label]generating samples…[/label]")
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=str(vendor_dir),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    stdout, _ = await proc.communicate()
    output = stdout.decode() if stdout else ""

    if proc.returncode != 0:
        console.print(
            f"     [state.err]✗[/state.err]  "
            f"[label]sample.py failed (exit {proc.returncode})[/label]"
        )
        for line in output.split("\n")[:4]:
            if line.strip():
                console.print(f"       [dim]{line.strip()}[/dim]")
        return {"sample_text": f"(generation failed: exit {proc.returncode})"}

    # Parse samples separated by "---------------"
    samples: list[str] = []
    current: list[str] = []
    for line in output.split("\n"):
        if line.strip() == "---------------":
            if current:
                samples.append("\n".join(current).strip())
                current = []
        elif not any(kw in line for kw in ["Loading meta", "number of parameters"]):
            current.append(line)
    if current:
        text = "\n".join(current).strip()
        if text:
            samples.append(text)

    if samples:
        preview = samples[0][:300].strip()
        lines   = preview.split("\n")[:5]
        console.print(
            f"     [state.ok]✓[/state.ok]  "
            f"[label]{len(samples)} samples  ·  "
            f"{len(samples[0])} chars[/label]"
        )
        for line in lines:
            console.print(f"       [dim italic]{line}[/dim italic]")
        if len(samples[0]) > 300:
            console.print("       [dim]…[/dim]")

        samples_path = run_dir / "samples.txt"
        samples_path.write_text(
            "\n\n--- sample ---\n\n".join(samples) + "\n"
        )
        return {"sample_text": samples[0]}
    else:
        console.print("     [label]no samples generated[/label]")
        return {"sample_text": "(no output)"}
