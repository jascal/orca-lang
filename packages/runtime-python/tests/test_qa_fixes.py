"""Regression tests for the Python-runtime QA findings.

Each test corresponds to a confirmed bug in
`reports/python-runtime-qa-report.md` (RT-06, RT-07, RT-12, RT-14) and is lifted
directly from the repro inlined in that report.

  RT-06  on_entry dropped when a state also declares `invoke`
  RT-07  resume()/restore() drop child machines and `active_invoke`
  RT-12  `event.*` guards parse but the event is never in guard scope
  RT-14  ordered comparisons fall back to string compare and fail open
"""

import asyncio
import warnings

from orca_runtime_python.parser import parse_orca_md
from orca_runtime_python.machine import OrcaMachine
from orca_runtime_python.bus import EventBus


# --------------------------------------------------------------------------
# RT-12 — event.* guards resolve against the event payload
# --------------------------------------------------------------------------

RT12_MD = """# machine pay

## events

- PAY

## state idle [initial]
## state approved [final]
## state denied [final]

## guards

| Name | Expression |
|------|------------|
| big | `event.amount > 100` |

## transitions

| Source | Event | Guard | Target |
|--------|-------|-------|--------|
| idle | PAY | big | approved |
| idle | PAY |     | denied   |
"""


async def _test_rt12_event_guard_denies_small_payload():
    m = OrcaMachine(parse_orca_md(RT12_MD), event_bus=EventBus())
    await m.start()
    await m.send("PAY", {"amount": 5})
    assert m.state == "denied", f"event.amount>100 with amount=5 should deny, got {m.state}"


async def _test_rt12_event_guard_approves_large_payload():
    m = OrcaMachine(parse_orca_md(RT12_MD), event_bus=EventBus())
    await m.start()
    await m.send("PAY", {"amount": 200})
    assert m.state == "approved", f"event.amount>100 with amount=200 should approve, got {m.state}"


RT12_MIXED_MD = """# machine mixed

## context

| Field | Type | Default |
|-------|------|---------|
| limit | number | 100 |

## events

- PAY

## state idle [initial]
## state approved [final]
## state denied [final]

## guards

| Name | Expression |
|------|------------|
| over | `event.amount > ctx.limit` |

## transitions

| Source | Event | Guard | Target |
|--------|-------|-------|--------|
| idle | PAY | over | approved |
| idle | PAY |     | denied   |
"""


async def _test_rt12_mixed_event_and_ctx_operands():
    # One comparison touches BOTH resolution paths: LHS is an event payload
    # field, RHS is a context field. Guards both that event and ctx resolve.
    over = OrcaMachine(parse_orca_md(RT12_MIXED_MD), event_bus=EventBus(), context={"limit": 100})
    await over.start()
    await over.send("PAY", {"amount": 200})
    assert over.state == "approved", f"event.amount(200) > ctx.limit(100) should approve, got {over.state}"

    under = OrcaMachine(parse_orca_md(RT12_MIXED_MD), event_bus=EventBus(), context={"limit": 100})
    await under.start()
    await under.send("PAY", {"amount": 50})
    assert under.state == "denied", f"event.amount(50) > ctx.limit(100) should deny, got {under.state}"


def test_rt12_event_guard_denies_small_payload():
    asyncio.run(_test_rt12_event_guard_denies_small_payload())


def test_rt12_event_guard_approves_large_payload():
    asyncio.run(_test_rt12_event_guard_approves_large_payload())


def test_rt12_mixed_event_and_ctx_operands():
    asyncio.run(_test_rt12_mixed_event_and_ctx_operands())


# --------------------------------------------------------------------------
# RT-14 — ordered comparisons fail closed on None / non-numeric operands
# --------------------------------------------------------------------------

RT14_MD = """# machine g

## context

| Field | Type | Default |
|-------|------|---------|
| x | number | |

## events

- GO

## state idle [initial]
## state done [final]
## state blocked [final]

## guards

| Name | Expression |
|------|------------|
| big | `ctx.x > 100` |

## transitions

| Source | Event | Guard | Target |
|--------|-------|-------|--------|
| idle | GO | big | done |
| idle | GO |     | blocked |
"""


async def _test_rt14_ordered_compare_none_fails_closed():
    m = OrcaMachine(parse_orca_md(RT14_MD), event_bus=EventBus(), context={"x": None})
    await m.start()
    await m.send("GO")
    assert m.state == "blocked", f"ctx.x>100 with x=None must be False (fail closed), got {m.state}"


async def _test_rt14_ordered_compare_nonnumeric_fails_closed():
    m = OrcaMachine(parse_orca_md(RT14_MD), event_bus=EventBus(), context={"x": "abc"})
    await m.start()
    await m.send("GO")
    assert m.state == "blocked", f"ctx.x>100 with x='abc' must be False (fail closed), got {m.state}"


async def _test_rt14_numeric_string_still_compares():
    # A numeric-looking string is still coerced and compared numerically — the
    # fix must not over-reject these.
    m = OrcaMachine(parse_orca_md(RT14_MD), event_bus=EventBus(), context={"x": "150"})
    await m.start()
    await m.send("GO")
    assert m.state == "done", f"ctx.x>100 with x='150' should pass, got {m.state}"


def test_rt14_ordered_compare_none_fails_closed():
    asyncio.run(_test_rt14_ordered_compare_none_fails_closed())


def test_rt14_ordered_compare_nonnumeric_fails_closed():
    asyncio.run(_test_rt14_ordered_compare_nonnumeric_fails_closed())


def test_rt14_numeric_string_still_compares():
    asyncio.run(_test_rt14_numeric_string_still_compares())


# --------------------------------------------------------------------------
# RT-06 / RT-07 — invoke + on_entry, and resume rehydration
# --------------------------------------------------------------------------

CHILD_MD = """# machine Child

## events

- FIN

## state running [initial]
## state ok [final]

## transitions

| Source | Event | Target |
|--------|-------|--------|
| running | FIN | ok |
"""

PARENT_MD = """# machine Parent

## events

- E
- DONE

## state working [initial]
- invoke: Child
- on_done: DONE
- on_entry: mark_entry
## state idle [final]

## transitions

| Source | Event | Target |
|--------|-------|--------|
| working | DONE | idle |
| working | E    | idle |
"""


async def _test_rt06_on_entry_runs_with_invoke():
    pdef, cdef = parse_orca_md(PARENT_MD), parse_orca_md(CHILD_MD)
    m = OrcaMachine(pdef, event_bus=EventBus())
    m.register_machines({"Child": cdef})
    calls = []
    m.register_action("mark_entry", lambda ctx, ev: calls.append(1))
    await m.start()
    assert calls == [1], f"on_entry must run exactly once alongside invoke, got {calls}"
    assert "working" in m._child_machines, "child machine should have started"
    assert m._active_invoke == "working", f"active_invoke should be 'working', got {m._active_invoke!r}"


def test_rt06_on_entry_runs_with_invoke():
    asyncio.run(_test_rt06_on_entry_runs_with_invoke())


async def _test_rt07_resume_rehydrates_child_and_active_invoke():
    pdef, cdef = parse_orca_md(PARENT_MD), parse_orca_md(CHILD_MD)
    parent = OrcaMachine(pdef, event_bus=EventBus())
    parent.register_machines({"Child": cdef})
    await parent.start()
    snap = parent.snapshot()
    assert list(snap["children"]) == ["working"]
    assert snap["active_invoke"] == "working"

    m2 = OrcaMachine(pdef, event_bus=EventBus())
    m2.register_machines({"Child": cdef})
    await m2.resume(snap)

    assert m2.state == "working"
    assert "working" in m2._child_machines, "child must be re-instantiated on resume"
    assert m2._active_invoke == "working", f"active_invoke must be restored, got {m2._active_invoke!r}"


async def _test_rt07_resumed_machine_is_not_wedged():
    # The core impact: a machine resumed in an invoke state must still be
    # drivable to on_done via its (rehydrated) child, not permanently stalled.
    pdef, cdef = parse_orca_md(PARENT_MD), parse_orca_md(CHILD_MD)
    parent = OrcaMachine(pdef, event_bus=EventBus())
    parent.register_machines({"Child": cdef})
    await parent.start()
    snap = parent.snapshot()

    m2 = OrcaMachine(pdef, event_bus=EventBus())
    m2.register_machines({"Child": cdef})
    await m2.resume(snap)

    # Drive the rehydrated child to its final state → completion handler fires
    # on_done ("DONE") on the parent, which transitions working -> idle.
    await m2._child_machines["working"].send("FIN")

    assert m2.state == "idle", f"parent should reach idle via on_done, got {m2.state}"
    assert "working" not in m2._child_machines, "completed child should be detached"
    assert m2._active_invoke is None, "active_invoke should clear after completion"


async def _test_rt07_resume_without_sibling_warns_not_crashes():
    # Child snapshot present but sibling def not registered → warn + skip,
    # rather than silently dropping or raising.
    pdef, cdef = parse_orca_md(PARENT_MD), parse_orca_md(CHILD_MD)
    parent = OrcaMachine(pdef, event_bus=EventBus())
    parent.register_machines({"Child": cdef})
    await parent.start()
    snap = parent.snapshot()

    m2 = OrcaMachine(pdef, event_bus=EventBus())  # NOTE: no register_machines
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        await m2.resume(snap)
    assert any("sibling" in str(w.message).lower() for w in caught), \
        "missing sibling should produce a warning"
    assert m2._child_machines == {}, "no child should be rehydrated without its sibling def"


def test_rt07_resume_rehydrates_child_and_active_invoke():
    asyncio.run(_test_rt07_resume_rehydrates_child_and_active_invoke())


def test_rt07_resumed_machine_is_not_wedged():
    asyncio.run(_test_rt07_resumed_machine_is_not_wedged())


def test_rt07_resume_without_sibling_warns_not_crashes():
    asyncio.run(_test_rt07_resume_without_sibling_warns_not_crashes())


if __name__ == "__main__":
    tests = [
        ("RT-12 event guard denies small payload", test_rt12_event_guard_denies_small_payload),
        ("RT-12 event guard approves large payload", test_rt12_event_guard_approves_large_payload),
        ("RT-12 mixed event.* and ctx.* operands", test_rt12_mixed_event_and_ctx_operands),
        ("RT-14 None fails closed", test_rt14_ordered_compare_none_fails_closed),
        ("RT-14 non-numeric fails closed", test_rt14_ordered_compare_nonnumeric_fails_closed),
        ("RT-14 numeric string still compares", test_rt14_numeric_string_still_compares),
        ("RT-06 on_entry runs with invoke", test_rt06_on_entry_runs_with_invoke),
        ("RT-07 resume rehydrates child + active_invoke", test_rt07_resume_rehydrates_child_and_active_invoke),
        ("RT-07 resumed machine is not wedged", test_rt07_resumed_machine_is_not_wedged),
        ("RT-07 resume without sibling warns", test_rt07_resume_without_sibling_warns_not_crashes),
    ]
    passed = failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"  PASS  {name}")
            passed += 1
        except Exception as e:
            print(f"  FAIL  {name}: {e}")
            failed += 1
    print(f"\n{passed} passed, {failed} failed, {passed + failed} total")
    if failed:
        exit(1)
