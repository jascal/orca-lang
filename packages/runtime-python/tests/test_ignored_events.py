"""Tests for ignored event enforcement."""

import asyncio
from orca_runtime_python.parser import parse_orca_md
from orca_runtime_python.machine import OrcaMachine
from orca_runtime_python.bus import EventBus


def ignored_event_machine_md() -> str:
    return """# machine test

## events

- GO
- PING

## state idle [initial]
> Idle state
- ignore: PING

## state done [final]
> Done state

## transitions

| Source | Event | Target |
|--------|-------|--------|
| idle   | GO    | done   |
"""


def multi_ignore_machine_md() -> str:
    return """# machine test

## events

- GO
- PING
- HEARTBEAT

## state idle [initial]
> Idle state
- ignore: PING
- ignore: HEARTBEAT

## state done [final]
> Done state

## transitions

| Source | Event | Target |
|--------|-------|--------|
| idle   | GO    | done   |
"""


def ignored_in_only_one_state_md() -> str:
    return """# machine test

## events

- GO
- PING
- RESET

## state idle [initial]
> Idle state
- ignore: PING

## state active
> Active state
- ignore: RESET

## state done [final]
> Done state

## transitions

| Source | Event | Target |
|--------|-------|--------|
| idle   | GO    | active |
| active | PING  | done   |
| active | GO    | done   |
"""


# ---- Parser tests ----

def test_parse_ignored_events():
    defn = parse_orca_md(ignored_event_machine_md())
    idle_state = next(s for s in defn.states if s.name == "idle")
    assert len(idle_state.ignored_events) == 1, f"Expected 1 ignored event, got {len(idle_state.ignored_events)}"
    assert idle_state.ignored_events[0] == "PING", f"Expected 'PING', got '{idle_state.ignored_events[0]}'"


def test_parse_multiple_ignored_events():
    defn = parse_orca_md(multi_ignore_machine_md())
    idle_state = next(s for s in defn.states if s.name == "idle")
    assert len(idle_state.ignored_events) == 2, f"Expected 2 ignored events, got {len(idle_state.ignored_events)}"
    assert "PING" in idle_state.ignored_events, "Expected PING in ignored events"
    assert "HEARTBEAT" in idle_state.ignored_events, "Expected HEARTBEAT in ignored events"


# ---- Runtime enforcement tests ----

async def _test_ignored_event_returns_silently():
    defn = parse_orca_md(ignored_event_machine_md())
    machine = OrcaMachine(defn, event_bus=EventBus())

    await machine.start()
    result = await machine.send("PING")

    # Ignored event: taken=False, no error
    assert result.taken is False, "Expected transition not taken"
    assert result.error is None, f"Expected no error for ignored event, got: {result.error}"
    assert machine.state.leaf() == "idle", f"Expected state 'idle', got '{machine.state.leaf()}'"


async def _test_unhandled_event_returns_error():
    src = """# machine test

## events

- GO
- UNKNOWN

## state idle [initial]
> Idle state

## state done [final]
> Done state

## transitions

| Source | Event | Target |
|--------|-------|--------|
| idle   | GO    | done   |
"""
    defn = parse_orca_md(src)
    machine = OrcaMachine(defn, event_bus=EventBus())

    await machine.start()
    result = await machine.send("UNKNOWN")

    # Unhandled event: taken=False, with error
    assert result.taken is False, "Expected transition not taken"
    assert result.error is not None, "Expected error for unhandled event"


async def _test_handled_event_still_works():
    defn = parse_orca_md(ignored_event_machine_md())
    machine = OrcaMachine(defn, event_bus=EventBus())

    await machine.start()
    result = await machine.send("GO")

    assert result.taken is True, f"Expected transition taken, got: {result.error}"
    assert result.to_state == "done", f"Expected state 'done', got '{result.to_state}'"


async def _test_multiple_ignored_events_enforced():
    defn = parse_orca_md(multi_ignore_machine_md())
    machine = OrcaMachine(defn, event_bus=EventBus())

    await machine.start()

    r1 = await machine.send("PING")
    assert r1.taken is False and r1.error is None, "PING should be silently ignored"

    r2 = await machine.send("HEARTBEAT")
    assert r2.taken is False and r2.error is None, "HEARTBEAT should be silently ignored"

    # Regular transition still works
    r3 = await machine.send("GO")
    assert r3.taken is True, f"Expected GO transition taken, got: {r3.error}"


async def _test_ignored_in_one_state_not_another():
    defn = parse_orca_md(ignored_in_only_one_state_md())
    machine = OrcaMachine(defn, event_bus=EventBus())

    await machine.start()

    # PING is ignored in idle
    r1 = await machine.send("PING")
    assert r1.taken is False and r1.error is None, "PING should be silently ignored in idle"

    # RESET is NOT ignored in idle (no transition, returns error)
    r1b = await machine.send("RESET")
    assert r1b.taken is False and r1b.error is not None, "RESET should return error in idle (not ignored, not handled)"

    # Move to active
    await machine.send("GO")
    assert machine.state.leaf() == "active", "Should be in active"

    # RESET is ignored in active
    r2 = await machine.send("RESET")
    assert r2.taken is False and r2.error is None, "RESET should be silently ignored in active"

    # PING is NOT ignored in active — has a transition
    r3 = await machine.send("PING")
    assert r3.taken is True, f"Expected PING transition in active, got: {r3.error}"


async def _test_ignored_event_only_in_specific_state():
    src = """# machine test

## events

- GO
- PING
- BACK

## state idle [initial]
> Idle state
- ignore: PING

## state active
> Active state

## transitions

| Source | Event | Target |
|--------|-------|--------|
| idle   | GO    | active |
| active | PING  | idle   |
| active | BACK  | idle   |
"""
    defn = parse_orca_md(src)
    machine = OrcaMachine(defn, event_bus=EventBus())

    await machine.start()

    # PING is ignored in idle
    r1 = await machine.send("PING")
    assert r1.taken is False and r1.error is None, "PING should be ignored in idle"

    # Transition to active
    await machine.send("GO")
    assert machine.state.leaf() == "active", "Should be in active state"

    # PING is NOT ignored in active — it has a transition
    r2 = await machine.send("PING")
    assert r2.taken is True, f"Expected PING transition in active, got: {r2.error}"


# ---- Sync test wrappers ----

def test_ignored_event_returns_silently():
    asyncio.run(_test_ignored_event_returns_silently())

def test_unhandled_event_returns_error():
    asyncio.run(_test_unhandled_event_returns_error())

def test_handled_event_still_works():
    asyncio.run(_test_handled_event_still_works())

def test_multiple_ignored_events_enforced():
    asyncio.run(_test_multiple_ignored_events_enforced())

def test_ignored_in_one_state_not_another():
    asyncio.run(_test_ignored_in_one_state_not_another())

def test_ignored_event_only_in_specific_state():
    asyncio.run(_test_ignored_event_only_in_specific_state())


if __name__ == "__main__":
    tests = [
        # Parser tests
        ("parse single ignored event", test_parse_ignored_events),
        ("parse multiple ignored events", test_parse_multiple_ignored_events),
        # Runtime tests
        ("ignored event returns silently (no error)", test_ignored_event_returns_silently),
        ("unhandled event returns error", test_unhandled_event_returns_error),
        ("handled event still transitions", test_handled_event_still_works),
        ("multiple ignored events enforced", test_multiple_ignored_events_enforced),
        ("ignored in one state does not affect another", test_ignored_in_one_state_not_another),
        ("ignored event only in specific state", test_ignored_event_only_in_specific_state),
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
