"""Action handlers for data preparation steps."""

import os
import sys
import asyncio
import subprocess
from pathlib import Path
from typing import Any


async def check_data(ctx: dict[str, Any], evt: Any = None) -> dict[str, Any]:
    """Check whether the shakespeare_char dataset is already prepared."""
    vendor_dir = Path(ctx["vendor_dir"])
    data_dir = vendor_dir / "data" / ctx.get("dataset", "shakespeare_char")

    train_bin = data_dir / "train.bin"
    val_bin = data_dir / "val.bin"
    meta_pkl = data_dir / "meta.pkl"

    exists = train_bin.exists() and val_bin.exists() and meta_pkl.exists()

    result: dict[str, Any] = {"data_exists": exists}

    if exists:
        # Report file sizes for context
        result["train_tokens"] = train_bin.stat().st_size // 2  # uint16
        result["val_tokens"] = val_bin.stat().st_size // 2

        import pickle
        with open(meta_pkl, "rb") as f:
            meta = pickle.load(f)
        result["vocab_size"] = meta["vocab_size"]
        print(f"  Data found: {result['train_tokens']:,} train tokens, "
              f"{result['val_tokens']:,} val tokens, vocab_size={meta['vocab_size']}")
    else:
        missing = []
        if not train_bin.exists():
            missing.append("train.bin")
        if not val_bin.exists():
            missing.append("val.bin")
        if not meta_pkl.exists():
            missing.append("meta.pkl")
        print(f"  Data missing: {', '.join(missing)}")

    return result


async def prepare_data(ctx: dict[str, Any], evt: Any = None) -> dict[str, Any]:
    """Download and tokenize the Shakespeare dataset by running prepare.py."""
    vendor_dir = Path(ctx["vendor_dir"])
    dataset = ctx.get("dataset", "shakespeare_char")
    prepare_script = vendor_dir / "data" / dataset / "prepare.py"

    if not prepare_script.exists():
        return {"error_message": f"prepare.py not found at {prepare_script}"}

    print(f"  Running {prepare_script.name}...")
    proc = await asyncio.create_subprocess_exec(
        sys.executable, str(prepare_script),
        cwd=str(vendor_dir),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    stdout, _ = await proc.communicate()
    output = stdout.decode() if stdout else ""

    if proc.returncode != 0:
        print(f"  prepare.py failed (exit {proc.returncode}):\n{output}")
        return {"error_message": f"Data preparation failed: {output[:500]}"}

    # Parse output for stats
    result: dict[str, Any] = {"data_exists": True}
    for line in output.split("\n"):
        line = line.strip()
        if line.startswith("length of dataset in characters:"):
            chars = line.split(":")[-1].strip().replace(",", "")
            result["data_chars"] = int(chars)
            print(f"  Dataset: {int(chars):,} characters")
        elif line.startswith("vocab size:"):
            vs = line.split(":")[-1].strip().replace(",", "")
            result["vocab_size"] = int(vs)
            print(f"  Vocab size: {vs}")
        elif "train has" in line:
            tokens = line.split("has")[-1].strip().split()[0].replace(",", "")
            result["train_tokens"] = int(tokens)
            print(f"  Train: {int(tokens):,} tokens")
        elif "val has" in line:
            tokens = line.split("has")[-1].strip().split()[0].replace(",", "")
            result["val_tokens"] = int(tokens)
            print(f"  Val: {int(tokens):,} tokens")

    return result
