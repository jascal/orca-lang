"""
orca-nanolab: Orca-orchestrated nanoGPT training lab.

Usage:
    python -m nanolab [options]

Options:
    --max-iters N       Training iterations (default: 500, use 100 for quick test)
    --device DEVICE     Device: cpu, cuda, mps (default: auto-detect)
    --run-dir DIR       Output directory (default: ./runs/<timestamp>)
    --run-id ID         Run identifier for persistence/logging (default: timestamp)
    --n-layer N         Transformer layers (default: 6)
    --n-head N          Attention heads (default: 6)
    --n-embd N          Embedding dimension (default: 384)
    --lr RATE           Learning rate (default: 1e-3)
    --dropout RATE      Dropout rate (default: 0.2)
    --batch-size N      Batch size (default: 64)
    --block-size N      Context length (default: 256)
    --persist           Save checkpoints and resume on restart
    --log FILE          Write structured JSONL audit log to FILE
    --refine            After training, ask Claude to refine the workflow
    --api-key KEY       Anthropic API key (or set ANTHROPIC_API_KEY env var)
    --model MODEL       Claude model for refinement (default: claude-sonnet-4-6)
"""

import argparse
import asyncio
import os
import sys
import time
from pathlib import Path

from orca_runtime_python.parser import parse_orca_md_multi

from .driver import run_pipeline
from .display.terminal import (
    console,
    print_refine_start,
    print_refine_result,
    print_refine_error,
)


ORCA_PATH = Path(__file__).parent.parent / "orca" / "training-lab.orca.md"


def detect_device() -> str:
    try:
        import torch
        if torch.cuda.is_available():
            return "cuda"
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps"
    except ImportError:
        pass
    return "cpu"


def load_machines() -> dict:
    source = ORCA_PATH.read_text()
    defns  = parse_orca_md_multi(source)
    return {d.name: d for d in defns}


def build_context(args: argparse.Namespace, run_dir: Path) -> dict:
    pkg_dir    = Path(__file__).parent
    vendor_dir = pkg_dir / "vendor"
    device     = args.device or detect_device()
    return {
        "vendor_dir":    str(vendor_dir.resolve()),
        "run_dir":       str(run_dir.resolve()),
        "dataset":       "shakespeare_char",
        "max_iters":     args.max_iters,
        "device":        device,
        "n_layer":       args.n_layer,
        "n_head":        args.n_head,
        "n_embd":        args.n_embd,
        "dropout":       args.dropout,
        "learning_rate": args.lr,
        "batch_size":    args.batch_size,
        "block_size":    args.block_size,
    }


async def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="nanolab",
        description="Orca-orchestrated nanoGPT training lab",
    )
    parser.add_argument("--max-iters",  type=int,   default=500)
    parser.add_argument("--device",     type=str,   default=None)
    parser.add_argument("--run-dir",    type=str,   default=None)
    parser.add_argument("--run-id",     type=str,   default=None)
    parser.add_argument("--n-layer",    type=int,   default=6)
    parser.add_argument("--n-head",     type=int,   default=6)
    parser.add_argument("--n-embd",     type=int,   default=384)
    parser.add_argument("--lr",         type=float, default=1e-3)
    parser.add_argument("--dropout",    type=float, default=0.2)
    parser.add_argument("--batch-size", type=int,   default=64)
    parser.add_argument("--block-size", type=int,   default=256)
    parser.add_argument("--persist",    action="store_true")
    parser.add_argument("--log",        type=str,   default=None)
    parser.add_argument("--refine",     action="store_true")
    parser.add_argument("--api-key",    type=str,   default=None)
    parser.add_argument("--model",      type=str,   default="claude-sonnet-4-6")

    args = parser.parse_args(argv)

    # Resolve run-dir and run-id
    timestamp = time.strftime("%Y%m%d-%H%M%S")
    run_id    = args.run_id or timestamp
    if args.run_dir:
        run_dir = Path(args.run_dir)
    else:
        run_dir = Path("runs") / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    # Auto-locate log file inside run_dir if --log not specified but --refine requested
    log_path: str | None = args.log
    if log_path is None and args.refine:
        log_path = str(run_dir / "audit.jsonl")

    machines = load_machines()
    ctx      = build_context(args, run_dir)

    # ── Persistence adapter ────────────────────────────────────────
    persistence = None
    if args.persist:
        from orca_runtime_python import FilePersistence
        persistence = FilePersistence(run_dir)

    # ── Log sink ───────────────────────────────────────────────────
    log_sink = None
    if log_path:
        from orca_runtime_python import FileSink
        log_sink = FileSink(log_path)

    # ── Run pipeline ───────────────────────────────────────────────
    final_ctx = await run_pipeline(
        machines,
        ctx,
        verbose=True,
        persistence=persistence,
        run_id=run_id if args.persist else None,
        log_sink=log_sink,
    )

    if log_sink:
        log_sink.close()

    exit_code = 0 if final_ctx.get("_final_state") == "completed" else 1

    # ── Phase 8: Refinement ────────────────────────────────────────
    if args.refine and final_ctx.get("_final_state") == "completed":
        api_key = args.api_key or os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            console.print(
                "\n  [metric.bad]--refine requires an API key.[/metric.bad]  "
                "[label]Pass --api-key or set ANTHROPIC_API_KEY.[/label]\n"
            )
        else:
            from .refine import refine_workflow, build_run_summary, parse_audit_log

            print_refine_start(str(ORCA_PATH), args.model)

            entries = parse_audit_log(log_path) if log_path else []
            summary = build_run_summary(final_ctx, entries)

            try:
                _, out_path = await refine_workflow(
                    final_ctx,
                    ORCA_PATH,
                    log_path,
                    api_key=api_key,
                    run_id=run_id,
                    model=args.model,
                )
                print_refine_result(str(out_path), summary)
            except Exception as exc:
                print_refine_error(str(exc))

    return exit_code


def cli():
    sys.exit(asyncio.run(main()))


if __name__ == "__main__":
    cli()
