"""Tests for production hardening gaps (Gap 1-4, M-1, M-2, M-3)."""

import asyncio
import warnings
from typing import Any
from orca_runtime_python.parser import parse_orca_md, ParseError
from orca_runtime_python.machine import OrcaMachine, MachineNotActiveError
from orca_runtime_python.persistence import PersistenceAdapter, AsyncPersistenceAdapter
from orca_runtime_python.bus import EventBus


SIMPLE_MD = """# machine simple
## state idle [initial]
## state done [final]
## transitions
| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| idle | GO | | done | |
"""

VERSIONED_MD = """# machine versioned
- version: 2.0.0
## state idle [initial]
## state done [final]
## transitions
| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| idle | GO | | done | |
"""


# ── Gap 1: snapshot includes machine name and definition_version ──────────────

async def _test_snapshot_includes_machine_name():
    bus = EventBus()
    defn = parse_orca_md(SIMPLE_MD)
    machine = OrcaMachine(defn, event_bus=bus)
    await machine.start()
    snap = machine.snapshot()
    assert snap["machine"] == "simple", f"Expected 'simple', got '{snap['machine']}'"
    assert "definition_version" in snap, "Expected definition_version in snapshot"
    assert snap["definition_version"] == "0.1.0"


def test_snapshot_includes_machine_name():
    asyncio.run(_test_snapshot_includes_machine_name())


# ── Gap 2: send() before start() raises MachineNotActiveError ────────────────

async def _test_send_before_start_raises():
    bus = EventBus()
    defn = parse_orca_md(SIMPLE_MD)
    machine = OrcaMachine(defn, event_bus=bus)
    raised = False
    try:
        await machine.send("GO")
    except MachineNotActiveError:
        raised = True
    assert raised, "Expected MachineNotActiveError when send() called before start()"


async def _test_send_after_stop_raises():
    bus = EventBus()
    defn = parse_orca_md(SIMPLE_MD)
    machine = OrcaMachine(defn, event_bus=bus)
    await machine.start()
    await machine.stop()
    raised = False
    try:
        await machine.send("GO")
    except MachineNotActiveError:
        raised = True
    assert raised, "Expected MachineNotActiveError when send() called after stop()"


async def _test_send_after_start_does_not_raise():
    bus = EventBus()
    defn = parse_orca_md(SIMPLE_MD)
    machine = OrcaMachine(defn, event_bus=bus)
    await machine.start()
    result = await machine.send("GO")
    assert result.taken is True


def test_send_before_start_raises():
    asyncio.run(_test_send_before_start_raises())

def test_send_after_stop_raises():
    asyncio.run(_test_send_after_stop_raises())

def test_send_after_start_does_not_raise():
    asyncio.run(_test_send_after_start_does_not_raise())


# ── Gap 3: AsyncPersistenceAdapter + auto-save + load_or_start ───────────────

class _InMemorySync:
    """Synchronous in-memory persistence for testing."""
    def __init__(self):
        self._store: dict[str, Any] = {}
        self.save_calls: int = 0

    def save(self, run_id: str, snapshot: dict[str, Any]) -> None:
        self._store[run_id] = snapshot
        self.save_calls += 1

    def load(self, run_id: str) -> dict[str, Any] | None:
        return self._store.get(run_id)

    def exists(self, run_id: str) -> bool:
        return run_id in self._store


class _InMemoryAsync:
    """Async in-memory persistence for testing."""
    def __init__(self):
        self._store: dict[str, Any] = {}
        self.save_calls: int = 0

    async def save(self, run_id: str, snapshot: dict[str, Any]) -> None:
        self._store[run_id] = snapshot
        self.save_calls += 1

    async def load(self, run_id: str) -> dict[str, Any] | None:
        return self._store.get(run_id)

    async def exists(self, run_id: str) -> bool:
        return run_id in self._store


async def _test_auto_save_sync_persistence():
    bus = EventBus()
    defn = parse_orca_md(SIMPLE_MD)
    p = _InMemorySync()
    machine = OrcaMachine(defn, event_bus=bus, persistence=p, run_id="run-1")
    await machine.start()
    assert p.save_calls == 0, "No save before first transition"
    await machine.send("GO")
    assert p.save_calls == 1, "Expected one save after transition"
    snap = p.load("run-1")
    assert snap is not None
    assert snap["machine"] == "simple"
    assert snap["state"] == "done"


async def _test_auto_save_async_persistence():
    bus = EventBus()
    defn = parse_orca_md(SIMPLE_MD)
    p = _InMemoryAsync()
    machine = OrcaMachine(defn, event_bus=bus, persistence=p, run_id="run-1")
    await machine.start()
    await machine.send("GO")
    assert p.save_calls == 1, "Expected one save after transition"
    snap = await p.load("run-1")
    assert snap is not None
    assert snap["state"] == "done"


async def _test_load_or_start_fresh():
    bus = EventBus()
    defn = parse_orca_md(SIMPLE_MD)
    p = _InMemorySync()
    machine = OrcaMachine(defn, event_bus=bus, persistence=p, run_id="run-fresh")
    await machine.load_or_start()
    assert machine.is_active
    assert machine.state.leaf() == "idle"


async def _test_load_or_start_resumes():
    bus = EventBus()
    defn = parse_orca_md(SIMPLE_MD)
    p = _InMemorySync()

    # First run: advance to done and save
    m1 = OrcaMachine(defn, event_bus=bus, persistence=p, run_id="run-resume")
    await m1.start()
    await m1.send("GO")
    assert p.exists("run-resume")

    # Second run: load_or_start should resume
    bus2 = EventBus()
    m2 = OrcaMachine(defn, event_bus=bus2, persistence=p, run_id="run-resume")
    await m2.load_or_start()
    assert m2.is_active
    assert m2.state.leaf() == "done"


async def _test_load_or_start_no_persistence():
    bus = EventBus()
    defn = parse_orca_md(SIMPLE_MD)
    machine = OrcaMachine(defn, event_bus=bus)
    await machine.load_or_start()
    assert machine.is_active
    assert machine.state.leaf() == "idle"


def test_auto_save_sync_persistence():
    asyncio.run(_test_auto_save_sync_persistence())

def test_auto_save_async_persistence():
    asyncio.run(_test_auto_save_async_persistence())

def test_load_or_start_fresh():
    asyncio.run(_test_load_or_start_fresh())

def test_load_or_start_resumes():
    asyncio.run(_test_load_or_start_resumes())

def test_load_or_start_no_persistence():
    asyncio.run(_test_load_or_start_no_persistence())


# ── Gap 4: version field on MachineDef; snapshot includes it; resume warns ───

def test_machine_def_default_version():
    defn = parse_orca_md(SIMPLE_MD)
    assert defn.version == "0.1.0"


def test_machine_def_parsed_version():
    defn = parse_orca_md(VERSIONED_MD)
    assert defn.version == "2.0.0"


async def _test_resume_version_mismatch_warns():
    bus = EventBus()
    defn = parse_orca_md(VERSIONED_MD)
    machine = OrcaMachine(defn, event_bus=bus)

    stale_snap = {
        "machine": "versioned",
        "definition_version": "1.0.0",
        "state": "idle",
        "context": {},
        "children": {},
        "active_invoke": None,
        "timestamp": 0.0,
    }

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        await machine.resume(stale_snap)
        version_warnings = [w for w in caught if issubclass(w.category, UserWarning)]
        assert len(version_warnings) == 1
        assert "1.0.0" in str(version_warnings[0].message)
        assert "2.0.0" in str(version_warnings[0].message)


async def _test_resume_matching_version_no_warn():
    bus = EventBus()
    defn = parse_orca_md(VERSIONED_MD)
    machine = OrcaMachine(defn, event_bus=bus)

    snap = {
        "machine": "versioned",
        "definition_version": "2.0.0",
        "state": "idle",
        "context": {},
        "children": {},
        "active_invoke": None,
        "timestamp": 0.0,
    }

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        await machine.resume(snap)
        version_warnings = [w for w in caught if issubclass(w.category, UserWarning)]
        assert len(version_warnings) == 0, "No warning expected for matching versions"


def test_resume_version_mismatch_warns():
    asyncio.run(_test_resume_version_mismatch_warns())

def test_resume_matching_version_no_warn():
    asyncio.run(_test_resume_matching_version_no_warn())


# ── M-1: parser raises ParseError on structurally invalid input ──────────────

def test_parse_error_no_initial_state():
    md = """# machine bad
## state a
## state b
## transitions
| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| a | GO | | b | |
"""
    raised = False
    try:
        parse_orca_md(md)
    except ParseError as e:
        raised = True
        assert "no [initial] state" in str(e)
    assert raised, "Expected ParseError for missing [initial] state"


def test_parse_error_undefined_transition_target():
    md = """# machine bad
## state a [initial]
## transitions
| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| a | GO | | nonexistent | |
"""
    raised = False
    try:
        parse_orca_md(md)
    except ParseError as e:
        raised = True
        assert "nonexistent" in str(e)
    assert raised, "Expected ParseError for undefined transition target"


def test_parse_error_undefined_guard():
    md = """# machine bad
## state a [initial]
## state b [final]
## transitions
| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| a | GO | noSuchGuard | b | |
"""
    raised = False
    try:
        parse_orca_md(md)
    except ParseError as e:
        raised = True
        assert "noSuchGuard" in str(e)
    assert raised, "Expected ParseError for undefined guard"


def test_parse_valid_machine_no_error():
    defn = parse_orca_md(SIMPLE_MD)
    assert defn.name == "simple"


# ── M-2: TransitionResult.to_state_leaf ──────────────────────────────────────

async def _test_transition_result_leaf():
    bus = EventBus()
    defn = parse_orca_md(SIMPLE_MD)
    machine = OrcaMachine(defn, event_bus=bus)
    await machine.start()
    result = await machine.send("GO")
    assert result.taken is True
    assert result.to_state_leaf == "done", f"Expected 'done', got '{result.to_state_leaf}'"
    assert result.to_state == "done"


def test_transition_result_leaf():
    asyncio.run(_test_transition_result_leaf())


if __name__ == "__main__":
    tests = [
        ("Gap1: snapshot includes machine name", test_snapshot_includes_machine_name),
        ("Gap2: send before start raises", test_send_before_start_raises),
        ("Gap2: send after stop raises", test_send_after_stop_raises),
        ("Gap2: send after start ok", test_send_after_start_does_not_raise),
        ("Gap3: auto-save sync", test_auto_save_sync_persistence),
        ("Gap3: auto-save async", test_auto_save_async_persistence),
        ("Gap3: load_or_start fresh", test_load_or_start_fresh),
        ("Gap3: load_or_start resumes", test_load_or_start_resumes),
        ("Gap3: load_or_start no persistence", test_load_or_start_no_persistence),
        ("Gap4: default version", test_machine_def_default_version),
        ("Gap4: parsed version", test_machine_def_parsed_version),
        ("Gap4: resume version mismatch warns", test_resume_version_mismatch_warns),
        ("Gap4: resume matching version no warn", test_resume_matching_version_no_warn),
        ("M-1: no initial state error", test_parse_error_no_initial_state),
        ("M-1: undefined target error", test_parse_error_undefined_transition_target),
        ("M-1: undefined guard error", test_parse_error_undefined_guard),
        ("M-1: valid machine no error", test_parse_valid_machine_no_error),
        ("M-2: to_state_leaf", test_transition_result_leaf),
    ]

    passed = 0
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"  PASS  {name}")
            passed += 1
        except Exception as e:
            print(f"  FAIL  {name}: {e}")
            failed += 1

    print(f"\n{passed} passed, {failed} failed, {passed + failed} total")
    if failed > 0:
        exit(1)
