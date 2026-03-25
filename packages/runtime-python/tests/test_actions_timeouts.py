"""Tests for action handler execution and timeout enforcement."""

import asyncio
from orca_runtime_python.parser import parse_orca
from orca_runtime_python.machine import OrcaMachine
from orca_runtime_python.bus import EventBus


def action_machine_src(action_name: str) -> str:
    return f"""machine test

events {{
  GO
}}

state idle [initial] {{
}}

state done [final] {{
}}

transitions {{
  idle + GO -> done : {action_name}
}}
"""


def timeout_machine_src(duration_sec: int) -> str:
    return f"""machine test

events {{
  GO
  MANUAL
}}

state waiting [initial] {{
  timeout: {duration_sec}s -> expired
}}

state expired {{
}}

state manual {{
}}

transitions {{
  waiting + MANUAL -> manual
}}
"""


# ---- Action handler tests ----

async def _test_action_handler_called():
    defn = parse_orca(action_machine_src("increment"))
    machine = OrcaMachine(defn, event_bus=EventBus(), context={"count": 0})

    handler_called = False

    def increment(ctx, evt=None):
        nonlocal handler_called
        handler_called = True
        return {"count": ctx["count"] + 1}

    machine.register_action("increment", increment)
    await machine.start()
    result = await machine.send("GO")
    assert result.taken is True, f"Expected transition taken, got: {result.error}"
    assert handler_called is True, "Expected action handler to be called"


async def _test_action_handler_receives_event_payload():
    defn = parse_orca(action_machine_src("track"))
    machine = OrcaMachine(defn, event_bus=EventBus(), context={"last_event": None})

    received_payload = None

    def track(ctx, evt=None):
        nonlocal received_payload
        received_payload = evt
        return {"last_event": evt}

    machine.register_action("track", track)
    await machine.start()
    await machine.send("GO", {"source": "test", "value": 42})
    assert received_payload is not None, "Expected payload to be received"
    assert received_payload["source"] == "test", f"Expected source 'test', got '{received_payload.get('source')}'"
    assert received_payload["value"] == 42, f"Expected value 42, got '{received_payload.get('value')}'"


async def _test_async_action_handler():
    defn = parse_orca(action_machine_src("async_op"))
    machine = OrcaMachine(defn, event_bus=EventBus(), context={"processed": False})

    async def async_op(ctx, evt=None):
        await asyncio.sleep(0.01)
        return {"processed": True}

    machine.register_action("async_op", async_op)
    await machine.start()
    result = await machine.send("GO")
    assert result.taken is True, f"Expected transition taken"


async def _test_no_handler_still_transitions():
    defn = parse_orca(action_machine_src("unregistered"))
    machine = OrcaMachine(defn, event_bus=EventBus(), context={"count": 0})
    # Don't register any handler

    await machine.start()
    result = await machine.send("GO")
    assert result.taken is True, f"Expected transition taken even without handler, got: {result.error}"
    assert result.to_state == "done", f"Expected state 'done', got '{result.to_state}'"


async def _test_unregister_action():
    defn = parse_orca(action_machine_src("increment"))
    machine = OrcaMachine(defn, event_bus=EventBus(), context={"count": 0})

    called = False

    def increment(ctx, evt=None):
        nonlocal called
        called = True
        return {"count": 1}

    machine.register_action("increment", increment)
    machine.unregister_action("increment")

    await machine.start()
    await machine.send("GO")
    assert called is False, "Expected handler NOT to be called after unregister"


async def _test_multiple_action_handlers():
    src = """machine test

events {
  STEP1
  STEP2
}

state a [initial] {
}

state b {
}

state c [final] {
}

transitions {
  a + STEP1 -> b : action1
  b + STEP2 -> c : action2
}
"""
    defn = parse_orca(src)
    machine = OrcaMachine(defn, event_bus=EventBus(), context={"log": []})

    def action1(ctx, evt=None):
        return {"log": ctx["log"] + ["a1"]}

    def action2(ctx, evt=None):
        return {"log": ctx["log"] + ["a2"]}

    machine.register_action("action1", action1)
    machine.register_action("action2", action2)

    await machine.start()
    await machine.send("STEP1")
    await machine.send("STEP2")
    assert machine.context["log"] == ["a1", "a2"], f"Expected ['a1', 'a2'], got {machine.context['log']}"


# ---- Timeout tests ----

async def _test_timeout_transitions():
    defn = parse_orca(timeout_machine_src(1))  # 1 second timeout
    machine = OrcaMachine(defn, event_bus=EventBus())

    await machine.start()
    assert machine.state.leaf() == "waiting", f"Expected state 'waiting', got '{machine.state.leaf()}'"

    # Wait for timeout to fire (1s + buffer)
    await asyncio.sleep(1.2)

    assert machine.state.leaf() == "expired", f"Expected state 'expired' after timeout, got '{machine.state.leaf()}'"


async def _test_timeout_cancelled_on_manual_transition():
    defn = parse_orca(timeout_machine_src(1))
    machine = OrcaMachine(defn, event_bus=EventBus())

    await machine.start()

    # Transition manually before timeout
    await machine.send("MANUAL")
    assert machine.state.leaf() == "manual", f"Expected state 'manual', got '{machine.state.leaf()}'"

    # Wait past original timeout
    await asyncio.sleep(1.2)

    # Should still be in 'manual', not 'expired'
    assert machine.state.leaf() == "manual", f"Expected state still 'manual' after timeout period, got '{machine.state.leaf()}'"


async def _test_timeout_cancelled_on_stop():
    defn = parse_orca(timeout_machine_src(1))
    machine = OrcaMachine(defn, event_bus=EventBus())

    await machine.start()
    await machine.stop()

    # Wait past timeout
    await asyncio.sleep(1.2)

    # Machine was stopped, so no transition should have occurred
    assert machine.state.leaf() == "waiting", f"Expected state 'waiting' after stop, got '{machine.state.leaf()}'"


# ---- Sync test wrappers ----

def test_action_handler_called():
    asyncio.run(_test_action_handler_called())

def test_action_handler_receives_event_payload():
    asyncio.run(_test_action_handler_receives_event_payload())

def test_async_action_handler():
    asyncio.run(_test_async_action_handler())

def test_no_handler_still_transitions():
    asyncio.run(_test_no_handler_still_transitions())

def test_unregister_action():
    asyncio.run(_test_unregister_action())

def test_multiple_action_handlers():
    asyncio.run(_test_multiple_action_handlers())

def test_timeout_transitions():
    asyncio.run(_test_timeout_transitions())

def test_timeout_cancelled_on_manual_transition():
    asyncio.run(_test_timeout_cancelled_on_manual_transition())

def test_timeout_cancelled_on_stop():
    asyncio.run(_test_timeout_cancelled_on_stop())


if __name__ == "__main__":
    tests = [
        # Action handler tests
        ("action handler called on transition", test_action_handler_called),
        ("action handler receives event payload", test_action_handler_receives_event_payload),
        ("async action handler", test_async_action_handler),
        ("no handler still transitions", test_no_handler_still_transitions),
        ("unregister action handler", test_unregister_action),
        ("multiple action handlers", test_multiple_action_handlers),
        # Timeout tests
        ("timeout transitions after duration", test_timeout_transitions),
        ("timeout cancelled on manual transition", test_timeout_cancelled_on_manual_transition),
        ("timeout cancelled on stop", test_timeout_cancelled_on_stop),
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
