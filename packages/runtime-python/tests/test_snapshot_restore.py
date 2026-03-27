"""Tests for snapshot() and restore() functionality."""

import asyncio
from orca_runtime_python.parser import parse_orca_md
from orca_runtime_python.machine import OrcaMachine
from orca_runtime_python.bus import EventBus


SIMPLE_MACHINE_MD = """# machine test

## context

| Field | Type | Default |
|-------|------|---------|
| count | number | 0 |

## events

- GO
- NEXT

## state idle [initial]
> Idle state

## state processing
> Processing state

## state done [final]
> Done state

## transitions

| Source | Event | Target |
|--------|-------|--------|
| idle   | GO    | processing |
| processing | NEXT | done |
"""


async def _test_snapshot_captures_state():
    bus = EventBus()
    definition = parse_orca_md(SIMPLE_MACHINE_MD)
    machine = OrcaMachine(definition, event_bus=bus)
    await machine.start()

    snap = machine.snapshot()
    assert snap["state"] == "idle", f"Expected state 'idle', got '{snap['state']}'"
    assert isinstance(snap["timestamp"], float), "Expected numeric timestamp"
    assert "context" in snap, "Expected context in snapshot"


async def _test_snapshot_after_transition():
    bus = EventBus()
    definition = parse_orca_md(SIMPLE_MACHINE_MD)
    machine = OrcaMachine(definition, event_bus=bus)
    await machine.start()

    await machine.send("GO")
    snap = machine.snapshot()
    assert snap["state"] == "processing", f"Expected state 'processing', got '{snap['state']}'"


async def _test_snapshot_captures_context():
    bus = EventBus()
    definition = parse_orca_md(SIMPLE_MACHINE_MD)
    machine = OrcaMachine(definition, event_bus=bus, context={"count": 42})
    await machine.start()

    snap = machine.snapshot()
    assert snap["context"]["count"] == 42, f"Expected count 42, got {snap['context']['count']}"


async def _test_snapshot_is_deep_copy():
    bus = EventBus()
    definition = parse_orca_md(SIMPLE_MACHINE_MD)
    ctx = {"count": 5}
    machine = OrcaMachine(definition, event_bus=bus, context=ctx)
    await machine.start()

    snap = machine.snapshot()
    # Mutating original context shouldn't affect snapshot
    ctx["count"] = 999
    assert snap["context"]["count"] == 5, "Snapshot should be a deep copy of context"


async def _test_restore_state():
    bus = EventBus()
    definition = parse_orca_md(SIMPLE_MACHINE_MD)
    machine = OrcaMachine(definition, event_bus=bus)
    await machine.start()

    # Advance to processing
    await machine.send("GO")
    assert machine.state.leaf() == "processing", "Should be in processing"

    # Take snapshot
    snap = machine.snapshot()

    # Advance to done
    await machine.send("NEXT")
    assert machine.state.leaf() == "done", "Should be in done"

    # Restore to processing
    await machine.restore(snap)
    assert machine.state.leaf() == "processing", f"Expected 'processing' after restore, got '{machine.state.leaf()}'"


async def _test_restore_context():
    bus = EventBus()
    definition = parse_orca_md(SIMPLE_MACHINE_MD)
    machine = OrcaMachine(definition, event_bus=bus, context={"count": 10})
    await machine.start()

    # Restore with different context
    await machine.restore({"state": "processing", "context": {"count": 99}})
    snap = machine.snapshot()
    assert snap["context"]["count"] == 99, f"Expected count 99, got {snap['context']['count']}"


async def _test_restore_is_deep_copy():
    bus = EventBus()
    definition = parse_orca_md(SIMPLE_MACHINE_MD)
    machine = OrcaMachine(definition, event_bus=bus)
    await machine.start()

    snap_data = {"state": "processing", "context": {"count": 7}}
    await machine.restore(snap_data)

    # Mutating the restore input should NOT affect the machine
    snap_data["context"]["count"] = 999
    current = machine.snapshot()
    assert current["context"]["count"] == 7, "Restore should deep-copy context"


async def _test_restore_preserves_active_state():
    bus = EventBus()
    definition = parse_orca_md(SIMPLE_MACHINE_MD)
    machine = OrcaMachine(definition, event_bus=bus)
    await machine.start()

    await machine.restore({"state": "processing", "context": {"count": 0}})

    # Machine should still be active and accept events
    assert machine.is_active, "Machine should remain active after restore"
    result = await machine.send("NEXT")
    assert result.taken is True, f"Expected transition taken after restore, got: {result.error}"
    assert machine.state.leaf() == "done", "Should transition to done after restore"


async def _test_round_trip():
    bus = EventBus()
    definition = parse_orca_md(SIMPLE_MACHINE_MD)
    machine = OrcaMachine(definition, event_bus=bus, context={"count": 42})
    await machine.start()

    await machine.send("GO")
    snap = machine.snapshot()

    # Create a new machine and restore
    bus2 = EventBus()
    machine2 = OrcaMachine(definition, event_bus=bus2)
    await machine2.start()
    await machine2.restore(snap)

    assert machine2.state.leaf() == "processing", "Restored machine should be in processing"
    assert machine2.snapshot()["context"]["count"] == 42, "Restored machine should have correct context"

    # Continue from restored state
    result = await machine2.send("NEXT")
    assert result.taken is True, "Restored machine should accept next transition"


# Test wrappers
def test_snapshot_captures_state():
    asyncio.run(_test_snapshot_captures_state())

def test_snapshot_after_transition():
    asyncio.run(_test_snapshot_after_transition())

def test_snapshot_captures_context():
    asyncio.run(_test_snapshot_captures_context())

def test_snapshot_is_deep_copy():
    asyncio.run(_test_snapshot_is_deep_copy())

def test_restore_state():
    asyncio.run(_test_restore_state())

def test_restore_context():
    asyncio.run(_test_restore_context())

def test_restore_is_deep_copy():
    asyncio.run(_test_restore_is_deep_copy())

def test_restore_preserves_active_state():
    asyncio.run(_test_restore_preserves_active_state())

def test_round_trip():
    asyncio.run(_test_round_trip())


if __name__ == "__main__":
    tests = [
        ("snapshot captures current state", test_snapshot_captures_state),
        ("snapshot after transition", test_snapshot_after_transition),
        ("snapshot captures context", test_snapshot_captures_context),
        ("snapshot is a deep copy", test_snapshot_is_deep_copy),
        ("restore restores state", test_restore_state),
        ("restore restores context", test_restore_context),
        ("restore is a deep copy", test_restore_is_deep_copy),
        ("restore preserves active state", test_restore_preserves_active_state),
        ("round trip snapshot/restore", test_round_trip),
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
