"""Tests for Phase 8: LLM workflow refinement."""

import json
import pytest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch


from nanolab.refine import (
    parse_audit_log,
    build_run_summary,
    build_prompt,
    refine_workflow,
    _strip_fence,
)


# ── Fixtures ───────────────────────────────────────────────────────────────────

SAMPLE_CTX = {
    "_final_state":    "completed",
    "dataset":         "shakespeare_char",
    "data_chars":      1003854,
    "vocab_size":      65,
    "train_tokens":    900000,
    "val_tokens":      100000,
    "max_iters":       500,
    "device":          "cpu",
    "val_loss":        2.2981,
    "best_val_loss":   2.2341,
    "train_loss":      2.2543,
    "iter_num":        500,
    "n_layer":         4,
    "n_head":          4,
    "n_embd":          256,
    "dropout":         0.0,
    "learning_rate":   6e-4,
    # Trial results from HyperSearch
    "trial_a_n_layer":  4,
    "trial_a_n_head":   4,
    "trial_a_n_embd":   256,
    "trial_a_dropout":  0.0,
    "trial_a_lr":       6e-4,
    "trial_a_max_iters": 100,
    "trial_a_val_loss": 2.3102,
    "trial_b_n_layer":  6,
    "trial_b_n_head":   6,
    "trial_b_n_embd":   384,
    "trial_b_dropout":  0.1,
    "trial_b_lr":       3e-4,
    "trial_b_max_iters": 100,
    "trial_b_val_loss": 2.3841,
}

SAMPLE_ENTRIES = [
    {
        "ts": "2026-03-27T10:00:00+00:00", "run_id": "test-run",
        "machine": "TrainingLab", "event": "START",
        "from": "idle", "to": "data_prep", "context_delta": {},
    },
    {
        "ts": "2026-03-27T10:00:01+00:00", "run_id": "test-run",
        "machine": "TrainingLab", "event": "DATA_READY",
        "from": "data_prep", "to": "hyper_search",
        "context_delta": {"vocab_size": 65, "train_tokens": 900000},
    },
    {
        "ts": "2026-03-27T10:00:10+00:00", "run_id": "test-run",
        "machine": "HyperSearch", "event": "(parallel sync)",
        "from": "running", "to": "comparing",
        "context_delta": {
            "trial_a_val_loss": 2.3102, "trial_b_val_loss": 2.3841,
        },
    },
    {
        "ts": "2026-03-27T10:00:11+00:00", "run_id": "test-run",
        "machine": "TrainingLab", "event": "HYPER_DONE",
        "from": "hyper_search", "to": "training",
        "context_delta": {"n_layer": 4, "n_embd": 256},
    },
    {
        "ts": "2026-03-27T10:00:40+00:00", "run_id": "test-run",
        "machine": "TrainingRun", "event": "TRAINED",
        "from": "training", "to": "converged",
        "context_delta": {"val_loss": 2.2981, "best_val_loss": 2.2341},
    },
    {
        "ts": "2026-03-27T10:00:41+00:00", "run_id": "test-run",
        "machine": "TrainingLab", "event": "TRAINING_DONE",
        "from": "training", "to": "evaluating",
        "context_delta": {"val_loss": 2.2981},
    },
    {
        "ts": "2026-03-27T10:00:45+00:00", "run_id": "test-run",
        "machine": "TrainingLab", "event": "EVAL_DONE",
        "from": "evaluating", "to": "completed",
        "context_delta": {"sample_text": "ROMEO: Hello"},
    },
]


# ── parse_audit_log ────────────────────────────────────────────────────────────

def test_parse_audit_log_reads_jsonl(tmp_path):
    """parse_audit_log reads and parses JSONL lines."""
    log = tmp_path / "audit.jsonl"
    log.write_text(
        json.dumps({"event": "START", "machine": "TrainingLab"}) + "\n" +
        json.dumps({"event": "DATA_READY", "machine": "TrainingLab"}) + "\n"
    )
    entries = parse_audit_log(log)
    assert len(entries) == 2
    assert entries[0]["event"] == "START"
    assert entries[1]["event"] == "DATA_READY"


def test_parse_audit_log_missing_file(tmp_path):
    """parse_audit_log returns empty list for missing files."""
    entries = parse_audit_log(tmp_path / "nope.jsonl")
    assert entries == []


def test_parse_audit_log_skips_bad_lines(tmp_path):
    """parse_audit_log skips lines that aren't valid JSON."""
    log = tmp_path / "audit.jsonl"
    log.write_text(
        json.dumps({"event": "START"}) + "\n"
        "not-json\n"
        + json.dumps({"event": "DONE"}) + "\n"
    )
    entries = parse_audit_log(log)
    assert len(entries) == 2


# ── build_run_summary ──────────────────────────────────────────────────────────

def test_build_run_summary_basic():
    """build_run_summary extracts key fields from context."""
    summary = build_run_summary(SAMPLE_CTX, [])
    assert summary["final_state"] == "completed"
    assert summary["dataset"] == "shakespeare_char"
    assert summary["vocab_size"] == 65
    assert summary["max_iters"] == 500
    assert summary["best_val_loss"] == pytest.approx(2.2341)


def test_build_run_summary_identifies_winner():
    """build_run_summary correctly identifies Trial A as the winner."""
    summary = build_run_summary(SAMPLE_CTX, [])
    assert summary["winner"] == "A"


def test_build_run_summary_winner_b():
    """When trial B has lower val_loss, winner is B."""
    ctx = dict(SAMPLE_CTX)
    ctx["trial_a_val_loss"] = 2.50
    ctx["trial_b_val_loss"] = 2.30
    summary = build_run_summary(ctx, [])
    assert summary["winner"] == "B"


def test_build_run_summary_trial_details():
    """Trial A/B configs are captured from context."""
    summary = build_run_summary(SAMPLE_CTX, [])
    a = summary["trials"]["trial_a"]
    b = summary["trials"]["trial_b"]
    assert a["n_layer"] == 4
    assert a["n_embd"] == 256
    assert b["n_layer"] == 6
    assert b["n_embd"] == 384


def test_build_run_summary_tl_transitions_from_log():
    """TrainingLab transitions are extracted from audit log entries."""
    summary = build_run_summary(SAMPLE_CTX, SAMPLE_ENTRIES)
    tl = summary["tl_transitions"]
    assert any("idle → data_prep" in t for t in tl)
    assert any("data_prep → hyper_search" in t for t in tl)
    assert any("evaluating → completed" in t for t in tl)


def test_build_run_summary_trial_val_loss_from_log():
    """Trial val_loss can be extracted from audit log deltas."""
    # ctx without trial val_loss, rely purely on log entries
    ctx = {k: v for k, v in SAMPLE_CTX.items()
           if "trial_a_val_loss" not in k and "trial_b_val_loss" not in k}
    summary = build_run_summary(ctx, SAMPLE_ENTRIES)
    a = summary["trials"].get("trial_a", {})
    b = summary["trials"].get("trial_b", {})
    assert a.get("val_loss") == pytest.approx(2.3102)
    assert b.get("val_loss") == pytest.approx(2.3841)


# ── build_prompt ───────────────────────────────────────────────────────────────

def test_build_prompt_contains_orca_md():
    """build_prompt includes the current .orca.md content."""
    summary = build_run_summary(SAMPLE_CTX, SAMPLE_ENTRIES)
    prompt  = build_prompt("# machine TrainingLab\n...\n", summary)
    assert "# machine TrainingLab" in prompt


def test_build_prompt_includes_trial_table():
    """build_prompt includes the HyperSearch trial comparison table."""
    summary = build_run_summary(SAMPLE_CTX, SAMPLE_ENTRIES)
    prompt  = build_prompt("", summary)
    assert "Trial A" in prompt
    assert "Trial B" in prompt
    assert "2.3102" in prompt
    assert "2.3841" in prompt


def test_build_prompt_includes_winner():
    """build_prompt identifies the winning trial."""
    summary = build_run_summary(SAMPLE_CTX, SAMPLE_ENTRIES)
    prompt  = build_prompt("", summary)
    assert "Trial A" in prompt
    assert "winner" in prompt.lower()


def test_build_prompt_mentions_refinement_axes():
    """build_prompt asks Claude to consider key improvement dimensions."""
    summary = build_run_summary(SAMPLE_CTX, SAMPLE_ENTRIES)
    prompt  = build_prompt("", summary)
    for kw in ["trial", "budget", "converge", "search", "default"]:
        assert kw.lower() in prompt.lower(), f"Expected '{kw}' in prompt"


# ── _strip_fence ───────────────────────────────────────────────────────────────

@pytest.mark.parametrize("fenced,expected", [
    ("```markdown\n# machine X\n```", "# machine X"),
    ("```orca.md\n# machine X\n```", "# machine X"),
    ("```\n# machine X\n```",         "# machine X"),
    ("# machine X",                   "# machine X"),
    ("```orca\n# machine X\n```",     "# machine X"),
])
def test_strip_fence(fenced, expected):
    assert _strip_fence(fenced) == expected


# ── refine_workflow (mocked LLM) ───────────────────────────────────────────────

@pytest.mark.asyncio
async def test_refine_workflow_saves_file(tmp_path):
    """refine_workflow writes the refined .orca.md to disk."""
    orca_path = tmp_path / "training-lab.orca.md"
    orca_path.write_text("# machine TrainingLab\n> Original\n")

    refined_content = "# machine TrainingLab\n> Refined by Claude\n"

    with patch("nanolab.refine.call_claude", new=AsyncMock(return_value=refined_content)):
        text, out_path = await refine_workflow(
            SAMPLE_CTX,
            orca_path,
            log_path=None,
            api_key="fake-key",
            run_id="test-001",
        )

    assert out_path.exists()
    assert "Refined by Claude" in out_path.read_text()
    assert "refined" in out_path.name
    assert "test-001" in out_path.name


@pytest.mark.asyncio
async def test_refine_workflow_strips_fences(tmp_path):
    """refine_workflow strips code fences from the LLM response."""
    orca_path = tmp_path / "training-lab.orca.md"
    orca_path.write_text("# machine TrainingLab\n")

    fenced = "```markdown\n# machine TrainingLab\n> Refined\n```"

    with patch("nanolab.refine.call_claude", new=AsyncMock(return_value=fenced)):
        text, _ = await refine_workflow(
            SAMPLE_CTX, orca_path, None, "fake-key", "run-1"
        )

    assert not text.startswith("```")
    assert "# machine TrainingLab" in text


@pytest.mark.asyncio
async def test_refine_workflow_uses_audit_log(tmp_path):
    """refine_workflow passes log entries through to the prompt."""
    orca_path = tmp_path / "training-lab.orca.md"
    orca_path.write_text("# machine TrainingLab\n")
    log_path = tmp_path / "audit.jsonl"
    log_path.write_text(
        "\n".join(json.dumps(e) for e in SAMPLE_ENTRIES) + "\n"
    )

    captured_prompt: list[str] = []

    async def mock_claude(prompt, api_key, **kwargs):
        captured_prompt.append(prompt)
        return "# machine TrainingLab\n> Refined\n"

    with patch("nanolab.refine.call_claude", new=mock_claude):
        await refine_workflow(
            SAMPLE_CTX, orca_path, log_path, "fake-key", "run-2"
        )

    assert captured_prompt, "call_claude was not called"
    prompt = captured_prompt[0]
    # Audit log trial results should appear in the prompt
    assert "2.3102" in prompt   # trial_a val_loss
    assert "2.3841" in prompt   # trial_b val_loss


@pytest.mark.asyncio
async def test_call_claude_raises_without_anthropic():
    """call_claude raises RuntimeError if anthropic is not installed."""
    from nanolab.refine import call_claude

    with patch.dict("sys.modules", {"anthropic": None}):
        with pytest.raises((RuntimeError, ImportError)):
            await call_claude("test prompt", "fake-key")
