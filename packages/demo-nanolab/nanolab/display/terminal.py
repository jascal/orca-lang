"""Terminal display helpers for the training lab."""

import time
from typing import Any


MACHINE_ICONS = {
    "TrainingLab": "🔬",
    "DataPipeline": "📂",
    "TrainingRun": "🏋️ ",
    "Evaluator": "📊",
}

STATE_ICONS = {
    "idle": "  ",
    "data_prep": "  ",
    "training": "  ",
    "evaluating": "  ",
    "completed": "✅",
    "failed": "❌",
    # DataPipeline
    "checking": "🔍",
    "downloading": "📦",
    "ready": "✓ ",
    "error": "✗ ",
    # TrainingRun
    "configuring": "⚙️ ",
    "converged": "✓ ",
    # Evaluator
    "generating": "✍️ ",
    "done": "✓ ",
}


def _indent(depth: int) -> str:
    return "   " * depth


def print_banner() -> None:
    print()
    print("🔬 orca-nanolab: nanoGPT Training Orchestrator")
    print("━" * 50)
    print()


def print_machine_start(machine_name: str, depth: int) -> None:
    icon = MACHINE_ICONS.get(machine_name, "  ")
    indent = _indent(depth)
    print(f"{indent}{icon} {machine_name}")


def print_transition(machine_name: str, from_state: str, to_state: str, depth: int) -> None:
    icon = STATE_ICONS.get(to_state, "  ")
    indent = _indent(depth)
    print(f"{indent}   {from_state} → {icon}{to_state}")


def print_machine_done(machine_name: str, final_state: str, elapsed: float, depth: int) -> None:
    icon = STATE_ICONS.get(final_state, "  ")
    indent = _indent(depth)
    status = "✓" if final_state not in ("error", "failed") else "✗"
    print(f"{indent}   → {icon}{final_state}  {status}  ({elapsed:.0f}s)")


def print_summary(ctx: dict[str, Any], elapsed: float) -> None:
    print()
    print("━" * 50)
    state = ctx.get("_final_state", "completed")
    if state == "completed":
        print("✅ Training Pipeline Complete")
    else:
        print(f"❌ Pipeline Failed: {ctx.get('error_message', 'unknown error')}")

    print()
    print("📋 Run Summary:")
    if ctx.get("data_chars"):
        print(f"   Dataset:    {ctx['data_chars']:,} chars, "
              f"vocab_size={ctx.get('vocab_size', '?')}")
    if ctx.get("train_tokens"):
        print(f"   Tokens:     {ctx['train_tokens']:,} train, "
              f"{ctx.get('val_tokens', 0):,} val")
    if ctx.get("val_loss"):
        print(f"   Final loss: train={ctx.get('train_loss', 0):.4f}, "
              f"val={ctx['val_loss']:.4f}")
    if ctx.get("best_val_loss", 999) < 999:
        print(f"   Best val:   {ctx['best_val_loss']:.4f}")
    if ctx.get("max_iters"):
        print(f"   Iterations: {ctx.get('iter_num', 0)}/{ctx['max_iters']}")
    print(f"   Total time: {elapsed:.0f}s")

    sample = ctx.get("sample_text", "")
    if sample and sample not in ("(no checkpoint to sample from)", "(no output)"):
        print()
        print("✍️  Sample output:")
        preview = sample[:400]
        for line in preview.split("\n")[:8]:
            print(f"   {line}")
        if len(sample) > 400:
            print("   ...")

    run_dir = ctx.get("run_dir", "")
    if run_dir:
        print()
        print(f"📂 Run artifacts: {run_dir}")
    print()
