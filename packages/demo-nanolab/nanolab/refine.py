"""
Phase 8: LLM-powered workflow refinement.

After a training run completes, this module:
1. Parses the JSONL audit log to extract key decisions and outcomes
2. Builds a compact run summary from context + audit events
3. Constructs a targeted refinement prompt
4. Calls Claude (via anthropic SDK) to produce an improved .orca.md
5. Saves the refined workflow for human review

The recursive narrative: the Orca machine that orchestrated training
now learns from what it observed and rewrites itself for the next run.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


# ── Audit log parsing ──────────────────────────────────────────────────────────

def parse_audit_log(log_path: str | Path) -> list[dict[str, Any]]:
    """Read a JSONL audit log and return entries as a list of dicts."""
    path = Path(log_path)
    if not path.exists():
        return []
    entries = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if line:
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return entries


def _extract_trial_results(
    entries: list[dict[str, Any]]
) -> dict[str, dict[str, Any]]:
    """
    Find the HyperSearch context_delta entries that contain trial_a_val_loss
    and trial_b_val_loss after the parallel sync completes.
    """
    trials: dict[str, dict[str, Any]] = {}
    for entry in entries:
        if entry.get("machine") != "HyperSearch":
            continue
        delta = entry.get("context_delta", {})
        for trial in ("trial_a", "trial_b"):
            if f"{trial}_val_loss" in delta:
                trials.setdefault(trial, {})
                trials[trial]["val_loss"] = delta[f"{trial}_val_loss"]
            for field in ("n_layer", "n_head", "n_embd", "dropout"):
                key = f"{trial}_{field}"
                if key in delta:
                    trials.setdefault(trial, {})[field] = delta[key]
            for field in ("lr", "max_iters"):
                key = f"{trial}_{field}"
                if key in delta:
                    trials.setdefault(trial, {})[field] = delta[key]
    return trials


def _find_winner(ctx: dict[str, Any]) -> str | None:
    """Return 'A' or 'B' based on which trial had lower val_loss."""
    a = ctx.get("trial_a_val_loss", 999.0)
    b = ctx.get("trial_b_val_loss", 999.0)
    if a == 999.0 and b == 999.0:
        return None
    return "A" if a <= b else "B"


def build_run_summary(
    ctx: dict[str, Any],
    entries: list[dict[str, Any]],
) -> dict[str, Any]:
    """
    Distil the final context and audit entries into a compact structured
    summary that can be injected into the refinement prompt.
    """
    trials = _extract_trial_results(entries)

    # Pull trial configs from ctx if not in audit deltas
    for label, prefix in (("trial_a", "trial_a"), ("trial_b", "trial_b")):
        t = trials.setdefault(label, {})
        for field in ("n_layer", "n_head", "n_embd", "dropout"):
            if field not in t:
                t[field] = ctx.get(f"{prefix}_{field}")
        if "lr" not in t:
            t["lr"] = ctx.get(f"{prefix}_lr")
        if "max_iters" not in t:
            t["max_iters"] = ctx.get(f"{prefix}_max_iters")
        if "val_loss" not in t:
            t["val_loss"] = ctx.get(f"{prefix}_val_loss", 999.0)

    winner = _find_winner(ctx) or _find_winner({
        "trial_a_val_loss": trials.get("trial_a", {}).get("val_loss", 999.0),
        "trial_b_val_loss": trials.get("trial_b", {}).get("val_loss", 999.0),
    })

    # Count eval checkpoints for the full training run
    eval_steps = [
        e for e in entries
        if e.get("machine") == "TrainingRun"
        and "val_loss" in e.get("context_delta", {})
    ]

    # Machine-level transition sequence (top-level TrainingLab only)
    tl_transitions = [
        f"{e['from']} → {e['to']}  ({e['event']})"
        for e in entries
        if e.get("machine") == "TrainingLab"
    ]

    return {
        "final_state":    ctx.get("_final_state", "?"),
        "dataset":        ctx.get("dataset", "shakespeare_char"),
        "data_chars":     ctx.get("data_chars", 0),
        "vocab_size":     ctx.get("vocab_size", 0),
        "train_tokens":   ctx.get("train_tokens", 0),
        "val_tokens":     ctx.get("val_tokens", 0),
        "max_iters":      ctx.get("max_iters", 500),
        "device":         ctx.get("device", "cpu"),
        "final_val_loss": ctx.get("val_loss", 0.0),
        "best_val_loss":  ctx.get("best_val_loss", 999.0),
        "final_n_layer":  ctx.get("n_layer"),
        "final_n_embd":   ctx.get("n_embd"),
        "final_lr":       ctx.get("learning_rate"),
        "trials":         trials,
        "winner":         winner,
        "eval_count":     len(eval_steps),
        "tl_transitions": tl_transitions,
    }


# ── Prompt construction ────────────────────────────────────────────────────────

def _fmt_trial_table(trials: dict[str, dict[str, Any]], winner: str | None) -> str:
    rows = []
    for label, prefix in (("Trial A", "trial_a"), ("Trial B", "trial_b")):
        t = trials.get(prefix, {})
        win_mark = "✓ winner" if (winner and winner.upper() in label) else ""
        rows.append(
            f"| {label:<8} | {t.get('n_layer','?'):>7} "
            f"| {t.get('n_embd','?'):>6} "
            f"| {t.get('lr', '?'):>8} "
            f"| {t.get('dropout','?'):>7} "
            f"| {t.get('max_iters','?'):>8} "
            f"| {t.get('val_loss', 999.0):.4f}  "
            f"| {win_mark} |"
        )
    header = (
        "| Trial    | n_layer | n_embd |       lr | dropout | max_iters | val_loss |        |\n"
        "|----------|---------|--------|----------|---------|-----------|----------|--------|"
    )
    return header + "\n" + "\n".join(rows)


def build_prompt(orca_md: str, summary: dict[str, Any]) -> str:
    """
    Construct the full refinement prompt to send to Claude.
    """
    trials_table = _fmt_trial_table(summary["trials"], summary.get("winner"))
    tl_flow = "\n".join(f"  {t}" for t in summary.get("tl_transitions", []))

    winner_label = summary.get("winner")
    winner_prefix = f"trial_{winner_label.lower()}" if winner_label else None
    winner_config = ""
    if winner_label and winner_prefix:
        t = summary["trials"].get(winner_prefix, {})
        winner_config = (
            f"  n_layer={t.get('n_layer','?')}  n_head={t.get('n_head','?')}  "
            f"n_embd={t.get('n_embd','?')}  lr={t.get('lr','?')}  dropout={t.get('dropout','?')}"
        )

    return f"""You are an expert ML training orchestrator and Orca state machine designer.

Your task: analyze the results of a nanoGPT training run and produce an improved
version of the Orca workflow definition that will perform better on the next run.

The Orca .orca.md format uses markdown headings and tables:
- `# machine Name` declares a machine
- `## context` table declares fields with defaults
- `## state NAME [initial|final]` declares states
- `## transitions` table has Source / Event / Target columns
- Machines are separated by `---`

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## CURRENT WORKFLOW
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

{orca_md}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## LAST RUN RESULTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**Outcome:**  {summary['final_state']}
**Dataset:**  {summary['dataset']}  ({summary['data_chars']:,} chars · vocab={summary['vocab_size']})
**Tokens:**   {summary['train_tokens']:,} train · {summary['val_tokens']:,} val
**Device:**   {summary['device']}
**Max iters:** {summary['max_iters']}

**HyperSearch Trials:**

{trials_table}

**Winning config (Trial {winner_label or '?'}):**
{winner_config}

**Full Training Run:**
- Iterations:     {summary['max_iters']}
- Final val_loss:  {summary['final_val_loss']:.4f}
- Best val_loss:   {summary['best_val_loss']:.4f}
- Eval checkpoints: {summary['eval_count']}

**TrainingLab transition sequence:**
{tl_flow}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## REFINEMENT REQUEST
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Based on this run, improve the workflow. Specifically consider:

1. **HyperSearch trial configs** — were the A/B configs differentiated enough?
   Should trial n_layer/n_embd/lr ranges be wider or shifted?
   Was the trial budget ({summary['trials'].get('trial_a', {}).get('max_iters','?')} iters) enough to distinguish configs?

2. **Full training budget** — did the model converge before {summary['max_iters']} iters?
   Should max_iters be adjusted up or down?

3. **Default context values** — do the TrainingLab context defaults reflect
   what this dataset/device actually needs?

4. **Search diversity** — should the two trial configs explore more diverse
   regions of hyperparameter space (e.g., very different learning rates,
   or batch sizes)?

5. **Any other improvements** — additional eval steps, smarter defaults,
   better trial comparison logic, etc.

Return ONLY the complete improved training-lab.orca.md file — all 5 machines,
separated by `---`, in valid .orca.md format. No explanations outside the file.
Use blockquotes (`> ...`) inside state descriptions to note what changed and why.
"""


# ── LLM call ───────────────────────────────────────────────────────────────────

async def call_claude(
    prompt: str,
    api_key: str,
    model: str = "claude-sonnet-4-6",
    max_tokens: int = 8192,
) -> str:
    """
    Call the Anthropic API with the refinement prompt.
    Returns the raw response text.
    """
    try:
        from anthropic import AsyncAnthropic
    except ImportError:
        raise RuntimeError(
            "anthropic package not installed. "
            "Run: pip install 'orca-demo-nanolab[llm]'"
        )

    client = AsyncAnthropic(api_key=api_key)
    message = await client.messages.create(
        model=model,
        max_tokens=max_tokens,
        messages=[{"role": "user", "content": prompt}],
    )
    return message.content[0].text


# ── Top-level entry point ──────────────────────────────────────────────────────

async def refine_workflow(
    ctx: dict[str, Any],
    orca_path: str | Path,
    log_path: str | Path | None,
    api_key: str,
    run_id: str = "latest",
    model: str = "claude-sonnet-4-6",
) -> tuple[str, Path]:
    """
    Run the full refinement pipeline:
      1. Parse the audit log (if available)
      2. Build run summary from ctx + log
      3. Construct prompt
      4. Call Claude
      5. Save refined .orca.md alongside original
      6. Return (refined_text, output_path)
    """
    orca_path = Path(orca_path)
    orca_md   = orca_path.read_text()

    entries: list[dict[str, Any]] = []
    if log_path:
        entries = parse_audit_log(log_path)

    summary = build_run_summary(ctx, entries)
    prompt  = build_prompt(orca_md, summary)

    refined_md = await call_claude(prompt, api_key, model=model)

    # Strip code fences if Claude wrapped the output
    refined_md = _strip_fence(refined_md)

    # Write next to original with run_id suffix
    out_path = orca_path.parent / f"{orca_path.stem.replace('.orca', '')}-refined-{run_id}.orca.md"
    out_path.write_text(refined_md)

    return refined_md, out_path


def _strip_fence(text: str) -> str:
    """Remove surrounding ```markdown / ``` fences if present."""
    text = text.strip()
    for prefix in ("```orca.md", "```markdown", "```md", "```orca", "```"):
        if text.startswith(prefix):
            text = text[len(prefix):]
            break
    if text.endswith("```"):
        text = text[:-3]
    return text.strip()
