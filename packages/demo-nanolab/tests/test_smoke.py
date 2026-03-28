"""Smoke tests for orca-nanolab — validate machine parsing and multi-machine pipeline."""

import asyncio
import pytest
from pathlib import Path
from unittest.mock import AsyncMock

from orca_runtime_python import OrcaMachine, EventBus
from orca_runtime_python.parser import parse_orca_md, parse_orca_md_multi


ORCA_PATH = Path(__file__).parent.parent / "orca" / "training-lab.orca.md"


def _load_all() -> dict:
    """Load all machine definitions from training-lab.orca.md."""
    source = ORCA_PATH.read_text()
    defns = parse_orca_md_multi(source)
    return {d.name: d for d in defns}


def _make_traininglab_context(**overrides):
    return {
        "vendor_dir": "/tmp/fake",
        "run_dir": "/tmp/fake-run",
        "dataset": "shakespeare_char",
        "max_iters": 100,
        "device": "cpu",
        "n_layer": 6, "n_head": 6, "n_embd": 384,
        "dropout": 0.2, "learning_rate": 0.001,
        "batch_size": 64, "block_size": 256,
        "data_exists": False, "data_chars": 0, "vocab_size": 0,
        "train_tokens": 0, "val_tokens": 0,
        "config_path": "", "train_loss": 0.0, "val_loss": 0.0,
        "best_val_loss": 999.0, "iter_num": 0,
        "sample_text": "", "error_message": "",
        **overrides,
    }


# ── Multi-machine parsing ──────────────────────────────────────────

def test_parse_all_machines():
    """training-lab.orca.md parses into 5 machines."""
    machines = _load_all()
    assert set(machines) == {"TrainingLab", "DataPipeline", "TrainingRun", "Evaluator", "HyperSearch"}


def test_traininglab_structure():
    """TrainingLab has correct states and transitions."""
    machines = _load_all()
    defn = machines["TrainingLab"]
    assert defn.name == "TrainingLab"
    state_names = {s.name for s in defn.states}
    for name in ["idle", "data_prep", "hyper_search", "training", "evaluating", "completed", "failed"]:
        assert name in state_names, f"Missing state: {name}"
    assert len(defn.transitions) == 9
    assert len(defn.effects) == 6


def test_traininglab_invoke_states():
    """TrainingLab invoke states reference the correct child machines."""
    machines = _load_all()
    defn = machines["TrainingLab"]
    state_map = {s.name: s for s in defn.states}

    assert state_map["data_prep"].invoke is not None
    assert state_map["data_prep"].invoke.machine == "DataPipeline"
    assert state_map["data_prep"].invoke.on_done == "DATA_READY"
    assert state_map["data_prep"].invoke.on_error == "ERROR"

    assert state_map["hyper_search"].invoke is not None
    assert state_map["hyper_search"].invoke.machine == "HyperSearch"
    assert state_map["hyper_search"].invoke.on_done == "HYPER_DONE"

    assert state_map["training"].invoke is not None
    assert state_map["training"].invoke.machine == "TrainingRun"
    assert state_map["training"].invoke.on_done == "TRAINING_DONE"

    assert state_map["evaluating"].invoke is not None
    assert state_map["evaluating"].invoke.machine == "Evaluator"
    assert state_map["evaluating"].invoke.on_done == "EVAL_DONE"


def test_datapipeline_structure():
    """DataPipeline has correct states, transitions, and entry actions."""
    machines = _load_all()
    defn = machines["DataPipeline"]
    state_map = {s.name: s for s in defn.states}

    assert state_map["checking"].is_initial
    assert state_map["checking"].on_entry == "check_data"
    assert state_map["downloading"].on_entry == "prepare_data"
    assert state_map["ready"].is_final
    assert state_map["error"].is_final
    assert len(defn.transitions) == 5


def test_trainingrun_structure():
    """TrainingRun has correct states and entry actions."""
    machines = _load_all()
    defn = machines["TrainingRun"]
    state_map = {s.name: s for s in defn.states}

    assert state_map["configuring"].is_initial
    assert state_map["configuring"].on_entry == "configure_run"
    assert state_map["training"].on_entry == "run_training"
    assert state_map["converged"].is_final
    assert state_map["failed"].is_final


def test_evaluator_structure():
    """Evaluator has correct states and entry actions."""
    machines = _load_all()
    defn = machines["Evaluator"]
    state_map = {s.name: s for s in defn.states}

    assert state_map["evaluating"].is_initial
    assert state_map["evaluating"].on_entry == "evaluate_model"
    assert state_map["generating"].on_entry == "generate_samples"
    assert state_map["done"].is_final
    assert state_map["error"].is_final


def test_hypersearch_structure():
    """HyperSearch has a parallel running state with two invoke regions."""
    machines = _load_all()
    defn = machines["HyperSearch"]
    state_map = {s.name: s for s in defn.states}

    assert state_map["configuring"].is_initial
    assert state_map["configuring"].on_entry == "configure_trials"

    running = state_map["running"]
    assert running.parallel is not None
    assert running.on_done == "comparing"
    region_names = {r.name for r in running.parallel.regions}
    assert region_names == {"trial_a", "trial_b"}

    # Both invoke states carry the TrainingRun invocation + on_done event
    region_map = {r.name: r for r in running.parallel.regions}
    run_a = next(s for s in region_map["trial_a"].states if s.name == "run_a")
    run_b = next(s for s in region_map["trial_b"].states if s.name == "run_b")
    assert run_a.invoke is not None
    assert run_a.invoke.machine == "TrainingRun"
    assert run_a.invoke.on_done == "TRIAL_A_DONE"
    assert "n_layer" in (run_a.invoke.input or {})
    assert run_b.invoke is not None
    assert run_b.invoke.machine == "TrainingRun"
    assert run_b.invoke.on_done == "TRIAL_B_DONE"

    assert state_map["comparing"].on_entry == "compare_trials"
    assert state_map["selected"].is_final
    assert state_map["exhausted"].is_final


def test_traininglab_effects():
    """TrainingLab effects section declares all 6 effects."""
    machines = _load_all()
    defn = machines["TrainingLab"]
    effect_names = {e.name for e in defn.effects}
    for name in ["FileCheck", "ShellExec", "ConfigWrite", "TrainSubproc",
                 "EstimateLoss", "TextGenerate"]:
        assert name in effect_names


# ── TrainingLab runtime transitions ───────────────────────────────

@pytest.mark.asyncio
async def test_traininglab_start():
    """TrainingLab starts in idle and transitions to data_prep on START."""
    machines = _load_all()
    defn = machines["TrainingLab"]
    machine = OrcaMachine(defn, event_bus=EventBus(), context=_make_traininglab_context())
    await machine.start()
    assert machine.state.leaf() == "idle"
    result = await machine.send("START")
    assert result.taken
    assert machine.state.leaf() == "data_prep"
    await machine.stop()


@pytest.mark.asyncio
async def test_traininglab_happy_path():
    """TrainingLab traverses the full happy path: idle → completed."""
    machines = _load_all()
    defn = machines["TrainingLab"]
    machine = OrcaMachine(defn, event_bus=EventBus(), context=_make_traininglab_context())
    await machine.start()

    steps = [
        ("START", "data_prep"),
        ("DATA_READY", "hyper_search"),
        ("HYPER_DONE", "training"),
        ("TRAINING_DONE", "evaluating"),
        ("EVAL_DONE", "completed"),
    ]
    for event, expected_state in steps:
        result = await machine.send(event)
        assert result.taken, f"{event} should be accepted"
        assert machine.state.leaf() == expected_state, \
            f"After {event}: expected {expected_state}, got {machine.state.leaf()}"

    await machine.stop()


@pytest.mark.asyncio
async def test_traininglab_error_paths():
    """ERROR from any invoke state sends TrainingLab to failed."""
    machines = _load_all()
    defn = machines["TrainingLab"]

    invoke_states = {
        "data_prep": ["START"],
        "hyper_search": ["START", "DATA_READY"],
        "training": ["START", "DATA_READY", "HYPER_DONE"],
        "evaluating": ["START", "DATA_READY", "HYPER_DONE", "TRAINING_DONE"],
    }
    for state_name, events_to_get_there in invoke_states.items():
        machine = OrcaMachine(defn, event_bus=EventBus(), context=_make_traininglab_context())
        await machine.start()
        for evt in events_to_get_there:
            await machine.send(evt)
        assert machine.state.leaf() == state_name

        result = await machine.send("ERROR")
        assert result.taken
        assert machine.state.leaf() == "failed"
        await machine.stop()


# ── DataPipeline runtime transitions ──────────────────────────────

@pytest.mark.asyncio
async def test_datapipeline_data_exists():
    """DataPipeline takes the fast path when data already exists."""
    machines = _load_all()
    defn = machines["DataPipeline"]
    ctx = {**defn.context, "vendor_dir": "/fake", "data_exists": False}

    # Register mock check_data that sets data_exists = True
    machine = OrcaMachine(defn, event_bus=EventBus(), context=ctx)
    machine.register_action("check_data", AsyncMock(return_value={"data_exists": True}))
    machine.register_action("prepare_data", AsyncMock(return_value={}))

    await machine.start()  # check_data runs here
    assert machine.context["data_exists"] is True

    result = await machine.send("DATA_EXISTS")
    assert result.taken
    assert machine.state.leaf() == "ready"
    await machine.stop()


@pytest.mark.asyncio
async def test_datapipeline_data_missing():
    """DataPipeline downloads when data is missing."""
    machines = _load_all()
    defn = machines["DataPipeline"]
    ctx = {**defn.context, "vendor_dir": "/fake"}

    machine = OrcaMachine(defn, event_bus=EventBus(), context=ctx)
    machine.register_action("check_data", AsyncMock(return_value={"data_exists": False}))
    machine.register_action("prepare_data", AsyncMock(return_value={"data_exists": True, "vocab_size": 65}))

    await machine.start()
    result = await machine.send("DATA_MISSING")
    assert result.taken
    assert machine.state.leaf() == "downloading"

    result = await machine.send("PREPARED")
    assert result.taken
    assert machine.state.leaf() == "ready"
    await machine.stop()


# ── Full pipeline with mocks ───────────────────────────────────────

@pytest.mark.asyncio
async def test_full_pipeline_with_mocks():
    """
    Run the complete multi-machine pipeline end-to-end using mock handlers.
    Verifies that all five machines run and context flows through correctly.
    HyperSearch runs 2 trial TrainingRuns in parallel; the full TrainingRun
    is a third call — so configure_run and run_training are called 3× each.
    """
    from nanolab.driver import run_pipeline, ACTION_REGISTRY

    machines = _load_all()

    # Patch all action handlers with mocks
    mock_check = AsyncMock(return_value={"data_exists": True, "vocab_size": 65,
                                         "train_tokens": 900000, "val_tokens": 100000})
    mock_prepare = AsyncMock(return_value={"data_exists": True})
    mock_configure = AsyncMock(return_value={"config_path": "/tmp/config.py"})
    mock_train = AsyncMock(return_value={"train_loss": 2.1, "val_loss": 2.3,
                                          "best_val_loss": 2.3, "iter_num": 100})
    mock_eval = AsyncMock(return_value={"train_loss": 2.0, "val_loss": 2.2})
    mock_gen = AsyncMock(return_value={"sample_text": "ROMEO: Hello world"})

    original = dict(ACTION_REGISTRY)
    ACTION_REGISTRY.update({
        "check_data": mock_check,
        "prepare_data": mock_prepare,
        "configure_run": mock_configure,
        "run_training": mock_train,
        "evaluate_model": mock_eval,
        "generate_samples": mock_gen,
    })

    try:
        ctx = _make_traininglab_context()
        result = await run_pipeline(machines, ctx, verbose=False)

        assert result["_final_state"] == "completed"
        # Context merging: DataPipeline results propagated back
        assert result["vocab_size"] == 65
        assert result["train_tokens"] == 900000
        # Evaluator results propagated back
        assert result["sample_text"] == "ROMEO: Hello world"
        assert result["val_loss"] == 2.2

        # configure_run and run_training each called 3× (trial_a, trial_b, full run)
        assert mock_configure.call_count == 3
        assert mock_train.call_count == 3
        mock_check.assert_called_once()
        mock_eval.assert_called_once()
        mock_gen.assert_called_once()

    finally:
        ACTION_REGISTRY.clear()
        ACTION_REGISTRY.update(original)


@pytest.mark.asyncio
async def test_pipeline_data_missing_flow():
    """Pipeline with data missing triggers prepare_data before training."""
    from nanolab.driver import run_pipeline, ACTION_REGISTRY

    machines = _load_all()

    mock_check = AsyncMock(return_value={"data_exists": False})
    mock_prepare = AsyncMock(return_value={"data_exists": True, "vocab_size": 65,
                                            "train_tokens": 900000, "val_tokens": 100000})
    mock_configure = AsyncMock(return_value={"config_path": "/tmp/config.py"})
    mock_train = AsyncMock(return_value={"train_loss": 2.5, "val_loss": 2.8,
                                          "best_val_loss": 2.8, "iter_num": 100})
    mock_eval = AsyncMock(return_value={"val_loss": 2.7})
    mock_gen = AsyncMock(return_value={"sample_text": "To be or not"})

    original = dict(ACTION_REGISTRY)
    ACTION_REGISTRY.update({
        "check_data": mock_check,
        "prepare_data": mock_prepare,
        "configure_run": mock_configure,
        "run_training": mock_train,
        "evaluate_model": mock_eval,
        "generate_samples": mock_gen,
    })

    try:
        result = await run_pipeline(machines, _make_traininglab_context(), verbose=False)
        assert result["_final_state"] == "completed"
        # Both check_data AND prepare_data were called
        mock_check.assert_called_once()
        mock_prepare.assert_called_once()
    finally:
        ACTION_REGISTRY.clear()
        ACTION_REGISTRY.update(original)


@pytest.mark.asyncio
async def test_pipeline_training_error():
    """Pipeline fails gracefully if training produces an error."""
    from nanolab.driver import run_pipeline, ACTION_REGISTRY

    machines = _load_all()

    original = dict(ACTION_REGISTRY)
    ACTION_REGISTRY.update({
        "check_data": AsyncMock(return_value={"data_exists": True}),
        "prepare_data": AsyncMock(return_value={}),
        "configure_run": AsyncMock(return_value={"config_path": "/tmp/config.py"}),
        "run_training": AsyncMock(return_value={"error_message": "CUDA out of memory"}),
        "evaluate_model": AsyncMock(return_value={}),
        "generate_samples": AsyncMock(return_value={}),
    })

    try:
        result = await run_pipeline(machines, _make_traininglab_context(), verbose=False)
        assert result["_final_state"] == "failed"
        assert result["error_message"] == "CUDA out of memory"
    finally:
        ACTION_REGISTRY.clear()
        ACTION_REGISTRY.update(original)
