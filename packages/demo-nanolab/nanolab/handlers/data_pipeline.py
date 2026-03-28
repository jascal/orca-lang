"""Action handlers for data preparation steps."""

import asyncio
import pickle
import sys
from pathlib import Path
from typing import Any

from nanolab.display.terminal import console


async def check_data(ctx: dict[str, Any], evt: Any = None) -> dict[str, Any]:
    """Check whether the shakespeare_char dataset is already prepared."""
    vendor_dir = Path(ctx["vendor_dir"])
    data_dir   = vendor_dir / "data" / ctx.get("dataset", "shakespeare_char")

    train_bin = data_dir / "train.bin"
    val_bin   = data_dir / "val.bin"
    meta_pkl  = data_dir / "meta.pkl"

    exists = train_bin.exists() and val_bin.exists() and meta_pkl.exists()
    result: dict[str, Any] = {"data_exists": exists}

    if exists:
        result["train_tokens"] = train_bin.stat().st_size // 2  # uint16
        result["val_tokens"]   = val_bin.stat().st_size // 2
        with open(meta_pkl, "rb") as f:
            meta = pickle.load(f)
        result["vocab_size"] = meta["vocab_size"]
        console.print(
            f"     [state.ok]✓[/state.ok]  [label]data found[/label]  "
            f"[metric.val]{result['train_tokens']:,}[/metric.val] [label]train tokens  ·  "
            f"vocab =[/label] [metric.val]{meta['vocab_size']}[/metric.val]"
        )
    else:
        missing = [
            p.name for p in (train_bin, val_bin, meta_pkl) if not p.exists()
        ]
        console.print(
            f"     [state.err]✗[/state.err]  [label]missing:[/label]  "
            f"[dim]{', '.join(missing)}[/dim]"
        )

    return result


async def prepare_data(ctx: dict[str, Any], evt: Any = None) -> dict[str, Any]:
    """Download and tokenize the Shakespeare dataset by running prepare.py."""
    vendor_dir     = Path(ctx["vendor_dir"])
    dataset        = ctx.get("dataset", "shakespeare_char")
    prepare_script = vendor_dir / "data" / dataset / "prepare.py"

    if not prepare_script.exists():
        return {"error_message": f"prepare.py not found at {prepare_script}"}

    console.print(f"     [label]running[/label]  [dim]{prepare_script.name}[/dim]")
    proc = await asyncio.create_subprocess_exec(
        sys.executable, str(prepare_script),
        cwd=str(vendor_dir),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    stdout, _ = await proc.communicate()
    output = stdout.decode() if stdout else ""

    if proc.returncode != 0:
        console.print(
            f"     [state.err]✗[/state.err]  [label]prepare.py failed "
            f"(exit {proc.returncode})[/label]"
        )
        return {"error_message": f"Data preparation failed: {output[:500]}"}

    result: dict[str, Any] = {"data_exists": True}
    for line in output.split("\n"):
        line = line.strip()
        if line.startswith("length of dataset in characters:"):
            chars = int(line.split(":")[-1].strip().replace(",", ""))
            result["data_chars"] = chars
            console.print(
                f"     [label]corpus[/label]  "
                f"[metric.val]{chars:,}[/metric.val] [label]characters[/label]"
            )
        elif line.startswith("vocab size:"):
            vs = int(line.split(":")[-1].strip().replace(",", ""))
            result["vocab_size"] = vs
            console.print(
                f"     [label]vocab[/label]   [metric.val]{vs}[/metric.val]"
            )
        elif "train has" in line:
            tokens = int(line.split("has")[-1].strip().split()[0].replace(",", ""))
            result["train_tokens"] = tokens
            console.print(
                f"     [label]train[/label]   [metric.val]{tokens:,}[/metric.val] [label]tokens[/label]"
            )
        elif "val has" in line:
            tokens = int(line.split("has")[-1].strip().split()[0].replace(",", ""))
            result["val_tokens"] = tokens
            console.print(
                f"     [label]val[/label]     [metric.val]{tokens:,}[/metric.val] [label]tokens[/label]"
            )

    return result
