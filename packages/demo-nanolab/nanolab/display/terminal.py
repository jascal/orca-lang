"""Rich terminal display for the nanolab pipeline."""

from __future__ import annotations

from typing import Any

from rich.console import Console, Group
from rich.panel import Panel
from rich.rule import Rule
from rich.table import Table
from rich.text import Text
from rich.theme import Theme
from rich import box


# ── Shared console ─────────────────────────────────────────────────────────────

_THEME = Theme({
    "machine":          "bold cyan",
    "machine.icon":     "cyan",
    "state":            "white",
    "state.ok":         "bold green",
    "state.err":        "bold red",
    "state.active":     "bold yellow",
    "transition.arrow": "dim cyan",
    "transition.from":  "dim white",
    "label":            "dim white",
    "metric.key":       "dim white",
    "metric.val":       "yellow",
    "metric.good":      "bold green",
    "metric.bad":       "red",
    "parallel":         "magenta",
    "trial.a":          "blue",
    "trial.b":          "magenta",
    "sample.text":      "italic white",
})

console = Console(theme=_THEME, highlight=False)

# ── Icons ──────────────────────────────────────────────────────────────────────

MACHINE_ICONS = {
    "TrainingLab": "🔬",
    "DataPipeline": "📂",
    "HyperSearch":  "🔍",
    "TrainingRun":  "🏋️ ",
    "Evaluator":    "📊",
}

_FINAL_OK  = frozenset({"completed", "ready", "converged", "selected", "done"})
_FINAL_ERR = frozenset({"failed", "error", "exhausted"})

def _state_style(state: str) -> str:
    if state in _FINAL_OK:
        return "state.ok"
    if state in _FINAL_ERR:
        return "state.err"
    return "state.active"

def _indent(depth: int) -> str:
    return "   " * depth


# ── Display functions (called from driver.py) ──────────────────────────────────

def print_banner() -> None:
    console.print()
    console.print(Rule(
        title="[bold cyan]🔬 orca-nanolab[/bold cyan]  [dim white]·  nanoGPT Training Orchestrator[/dim white]",
        style="cyan",
    ))
    console.print()


def print_machine_start(machine_name: str, depth: int) -> None:
    icon = MACHINE_ICONS.get(machine_name, "  ")
    indent = _indent(depth)
    if depth == 0:
        # Top-level machine — subtle separator
        console.print(f"{indent}[machine]{icon}  {machine_name}[/machine]")
    else:
        console.print(f"{indent}[dim cyan]{icon}[/dim cyan]  [machine]{machine_name}[/machine]")


def print_transition(
    machine_name: str, from_state: str, to_state: str, depth: int
) -> None:
    indent = _indent(depth)
    style = _state_style(to_state)
    console.print(
        f"{indent}   [transition.from]{from_state}[/transition.from]"
        f"  [transition.arrow]→[/transition.arrow]"
        f"  [{style}]{to_state}[/{style}]"
    )


def print_machine_done(
    machine_name: str, final_state: str, elapsed: float, depth: int
) -> None:
    indent = _indent(depth)
    ok = final_state not in _FINAL_ERR
    icon = "✓" if ok else "✗"
    style = "state.ok" if ok else "state.err"
    console.print(
        f"{indent}   [{style}]{icon}  {final_state}[/{style}]"
        f"  [label]({elapsed:.0f}s)[/label]"
    )


def print_summary(ctx: dict[str, Any], elapsed: float) -> None:
    console.print()

    state   = ctx.get("_final_state", "?")
    success = state == "completed"

    # ── Metrics table ──────────────────────────────────────────────
    table = Table(
        box=box.SIMPLE,
        show_header=False,
        padding=(0, 2),
        expand=False,
        show_edge=False,
    )
    table.add_column("key",   style="metric.key",  min_width=16)
    table.add_column("value", style="metric.val")

    dataset = ctx.get("dataset", "")
    if dataset:
        table.add_row("Dataset", dataset)

    data_chars = ctx.get("data_chars", 0)
    vocab_size = ctx.get("vocab_size", 0)
    if data_chars:
        table.add_row("Corpus", f"{data_chars:,} chars  ·  vocab = {vocab_size}")

    train_tokens = ctx.get("train_tokens", 0)
    val_tokens   = ctx.get("val_tokens", 0)
    if train_tokens:
        table.add_row("Tokens", f"{train_tokens:,} train  ·  {val_tokens:,} val")

    n_layer = ctx.get("n_layer")
    n_head  = ctx.get("n_head")
    n_embd  = ctx.get("n_embd")
    lr      = ctx.get("learning_rate")
    dropout = ctx.get("dropout")
    if n_layer and n_embd:
        parts = [f"n_layer={n_layer}", f"n_head={n_head}", f"n_embd={n_embd}"]
        if dropout is not None:
            parts.append(f"dropout={dropout}")
        if lr:
            parts.append(f"lr={lr:.0e}")
        table.add_row("Best config", "  ·  ".join(parts))

    train_loss = ctx.get("train_loss", 0.0)
    val_loss   = ctx.get("val_loss", 0.0)
    if val_loss:
        table.add_row(
            "Final loss",
            f"train [dim]=[/dim] [metric.val]{train_loss:.4f}[/metric.val]"
            f"  ·  val [dim]=[/dim] [metric.good]{val_loss:.4f}[/metric.good]",
        )

    best_val = ctx.get("best_val_loss", 999.0)
    if best_val < 999.0:
        table.add_row("Best val loss", f"[metric.good]{best_val:.4f}[/metric.good]")

    iter_num  = ctx.get("iter_num", 0)
    max_iters = ctx.get("max_iters", 0)
    if iter_num and max_iters:
        table.add_row("Iterations", f"{iter_num:,} / {max_iters:,}")

    table.add_row("Total time", f"{elapsed:.0f}s")

    if not success:
        err = ctx.get("error_message", "unknown error")
        table.add_row("[metric.bad]Error[/metric.bad]", f"[metric.bad]{err}[/metric.bad]")

    # ── Sample text ────────────────────────────────────────────────
    sample = ctx.get("sample_text", "")
    skip   = {"(no checkpoint to sample from)", "(no output)", ""}
    show_sample = sample not in skip and bool(sample)

    if show_sample:
        preview = sample[:400].strip()
        lines   = preview.split("\n")[:8]
        body    = "\n".join(f"  {line}" for line in lines)
        if len(sample) > 400:
            body += "\n  [dim]…[/dim]"
        sample_panel = Panel(
            Text.from_markup(f"[sample.text]{body}[/sample.text]"),
            title="[dim]Generated sample[/dim]",
            border_style="dim cyan",
            padding=(0, 1),
        )
        content: Any = Group(table, Text(""), sample_panel)
    else:
        content = table

    run_dir  = ctx.get("run_dir", "")
    subtitle = f"[label]📂 {run_dir}[/label]" if run_dir else None

    title_style  = "bold green" if success else "bold red"
    border_style = "green" if success else "red"
    title_icon   = "✅" if success else "❌"
    title_label  = "Training Complete" if success else "Pipeline Failed"

    console.print(Panel(
        content,
        title=f"[{title_style}]{title_icon}  {title_label}[/{title_style}]",
        subtitle=subtitle,
        border_style=border_style,
        padding=(1, 2),
    ))
    console.print()
