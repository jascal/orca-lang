"""
orca-nanolab: Orca-orchestrated nanoGPT training lab.

Usage:
    python -m nanolab [options]

Options:
    --max-iters N      Training iterations (default: 500, use 100 for quick test)
    --device DEVICE    Device: cpu, cuda, mps (default: auto-detect)
    --run-dir DIR      Output directory (default: ./runs/<timestamp>)
    --n-layer N        Transformer layers (default: 6)
    --n-head N         Attention heads (default: 6)
    --n-embd N         Embedding dimension (default: 384)
    --lr RATE          Learning rate (default: 1e-3)
    --dropout RATE     Dropout rate (default: 0.2)
    --batch-size N     Batch size (default: 64)
    --block-size N     Context length (default: 256)
"""

import argparse
import asyncio
import sys
import time
from pathlib import Path

from orca_runtime_python.parser import parse_orca_md_multi

from .driver import run_pipeline


def detect_device() -> str:
    """Auto-detect the best available device."""
    try:
        import torch
        if torch.cuda.is_available():
            return "cuda"
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps"
    except ImportError:
        pass
    return "cpu"


def build_context(args: argparse.Namespace) -> dict:
    """Build the initial context for TrainingLab from CLI args."""
    pkg_dir = Path(__file__).parent
    vendor_dir = pkg_dir / "vendor"

    if args.run_dir:
        run_dir = Path(args.run_dir)
    else:
        timestamp = time.strftime("%Y%m%d-%H%M%S")
        run_dir = Path("runs") / timestamp

    device = args.device or detect_device()

    return {
        "vendor_dir": str(vendor_dir.resolve()),
        "run_dir": str(run_dir.resolve()),
        "dataset": "shakespeare_char",
        "max_iters": args.max_iters,
        "device": device,
        "n_layer": args.n_layer,
        "n_head": args.n_head,
        "n_embd": args.n_embd,
        "dropout": args.dropout,
        "learning_rate": args.lr,
        "batch_size": args.batch_size,
        "block_size": args.block_size,
    }


def load_machines() -> dict:
    """Load all machine definitions from training-lab.orca.md."""
    orca_path = Path(__file__).parent.parent / "orca" / "training-lab.orca.md"
    source = orca_path.read_text()
    defns = parse_orca_md_multi(source)
    machines = {d.name: d for d in defns}
    print(f"Loaded {len(machines)} machines: {', '.join(machines)}")
    return machines


async def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="nanolab",
        description="Orca-orchestrated nanoGPT training lab",
    )
    parser.add_argument("--max-iters", type=int, default=500)
    parser.add_argument("--device", type=str, default=None)
    parser.add_argument("--run-dir", type=str, default=None)
    parser.add_argument("--n-layer", type=int, default=6)
    parser.add_argument("--n-head", type=int, default=6)
    parser.add_argument("--n-embd", type=int, default=384)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--dropout", type=float, default=0.2)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--block-size", type=int, default=256)

    args = parser.parse_args(argv)
    machines = load_machines()
    ctx = build_context(args)

    print(f"Device: {ctx['device']}, Max iters: {ctx['max_iters']}")
    print(f"Run dir: {ctx['run_dir']}")

    final_ctx = await run_pipeline(machines, ctx, verbose=True)
    return 0 if final_ctx.get("_final_state") == "completed" else 1


def cli():
    sys.exit(asyncio.run(main()))


if __name__ == "__main__":
    cli()
