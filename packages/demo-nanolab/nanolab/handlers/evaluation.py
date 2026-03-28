"""Action handlers for model evaluation and sample generation."""

import sys
import asyncio
import re
from pathlib import Path
from typing import Any


async def evaluate_model(ctx: dict[str, Any], evt: Any = None) -> dict[str, Any]:
    """Evaluate the trained model by running an eval-only pass."""
    vendor_dir = Path(ctx["vendor_dir"])
    run_dir = Path(ctx["run_dir"])
    checkpoint_dir = run_dir / "checkpoints"
    ckpt_path = checkpoint_dir / "ckpt.pt"

    if not ckpt_path.exists():
        # No checkpoint saved (training may have been too short) — use last training metrics
        print("  No checkpoint found — using training metrics")
        return {}

    config_path = ctx.get("config_path", str(run_dir / "config.py"))

    # Run train.py with eval_only=True to get final loss estimate
    cmd = [
        sys.executable, str(vendor_dir / "train.py"),
        str(config_path),
        "--eval_only=True",
        "--init_from=resume",
        f"--out_dir={checkpoint_dir}",
    ]

    print(f"  Evaluating checkpoint...")
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=str(vendor_dir),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    stdout, _ = await proc.communicate()
    output = stdout.decode() if stdout else ""

    result: dict[str, Any] = {}
    eval_pattern = re.compile(
        r"step \d+: train loss ([\d.]+), val loss ([\d.]+)"
    )
    for line in output.split("\n"):
        m = eval_pattern.search(line)
        if m:
            result["train_loss"] = float(m.group(1))
            result["val_loss"] = float(m.group(2))
            print(f"  Eval: train_loss={result['train_loss']:.4f}, "
                  f"val_loss={result['val_loss']:.4f}")

    return result


async def generate_samples(ctx: dict[str, Any], evt: Any = None) -> dict[str, Any]:
    """Generate text samples from the trained model using sample.py."""
    vendor_dir = Path(ctx["vendor_dir"])
    run_dir = Path(ctx["run_dir"])
    checkpoint_dir = run_dir / "checkpoints"
    ckpt_path = checkpoint_dir / "ckpt.pt"

    if not ckpt_path.exists():
        print("  No checkpoint found — skipping sample generation")
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
        f"--start=\\n",
    ]

    print(f"  Generating samples...")
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=str(vendor_dir),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    stdout, _ = await proc.communicate()
    output = stdout.decode() if stdout else ""

    if proc.returncode != 0:
        print(f"  Sample generation failed (exit {proc.returncode})")
        # Show first few lines of output for debugging
        for line in output.split("\n")[:5]:
            if line.strip():
                print(f"    {line.strip()}")
        return {"sample_text": f"(generation failed: exit {proc.returncode})"}

    # Parse samples — they're separated by "---------------"
    samples = []
    current_sample: list[str] = []
    for line in output.split("\n"):
        if line.strip() == "---------------":
            if current_sample:
                samples.append("\n".join(current_sample).strip())
                current_sample = []
        elif not any(kw in line for kw in ["Loading meta", "number of parameters"]):
            current_sample.append(line)
    if current_sample:
        text = "\n".join(current_sample).strip()
        if text:
            samples.append(text)

    if samples:
        # Show first sample (truncated)
        preview = samples[0][:300]
        print(f"  Sample 1 ({len(samples[0])} chars):")
        for line in preview.split("\n")[:6]:
            print(f"    {line}")
        if len(samples[0]) > 300:
            print(f"    ...")

        # Save all samples
        samples_path = run_dir / "samples.txt"
        samples_path.write_text(
            "\n\n--- sample ---\n\n".join(samples) + "\n"
        )
        print(f"  {len(samples)} samples saved to {samples_path}")

        return {"sample_text": samples[0]}
    else:
        print("  No samples generated")
        return {"sample_text": "(no output)"}
