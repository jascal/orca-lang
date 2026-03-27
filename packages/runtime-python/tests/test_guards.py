"""Tests for guard expression parsing and evaluation."""

import asyncio
from orca_runtime_python.parser import parse_orca_md
from orca_runtime_python.machine import OrcaMachine
from orca_runtime_python.bus import EventBus
from orca_runtime_python.types import (
    GuardTrue,
    GuardFalse,
    GuardCompare,
    GuardAnd,
    GuardOr,
    GuardNot,
    GuardNullcheck,
)


def orca_md(guard_expr: str, context_line: str = "") -> str:
    """Helper to create a minimal Orca machine definition string in markdown format."""
    ctx_table = ""
    if context_line:
        ctx_table = f"""
## context

| Field | Type | Default |
|-------|------|---------|
| {context_line} | number | 0 |
"""
    return f"""# machine test
{ctx_table}

## events

- GO

## state idle [initial]
> Idle state

## state done [final]
> Done state

## guards

| Name | Expression |
|------|------------|
| g | `{guard_expr}` |

## transitions

| Source | Event | Target | Guard |
|--------|-------|--------|-------|
| idle   | GO    | done   | g |
"""


# ---- Parser tests ----

def test_parse_true():
    defn = parse_orca_md(orca_md("true"))
    guard = defn.guards["g"]
    assert isinstance(guard, GuardTrue), f"Expected GuardTrue, got {type(guard)}"


def test_parse_false():
    defn = parse_orca_md(orca_md("false"))
    guard = defn.guards["g"]
    assert isinstance(guard, GuardFalse), f"Expected GuardFalse, got {type(guard)}"


def test_parse_compare():
    defn = parse_orca_md(orca_md("ctx.retry_count < 3", "retry_count"))
    guard = defn.guards["g"]
    assert isinstance(guard, GuardCompare), f"Expected GuardCompare, got {type(guard)}"
    assert guard.op == "lt", f"Expected op 'lt', got '{guard.op}'"
    assert guard.left.path == ["ctx", "retry_count"], f"Expected path ['ctx', 'retry_count'], got {guard.left.path}"
    assert guard.right.value == 3, f"Expected value 3, got {guard.right.value}"


def test_parse_nullcheck_ne():
    defn = parse_orca_md(orca_md("ctx.token != null", "token"))
    guard = defn.guards["g"]
    assert isinstance(guard, GuardNullcheck), f"Expected GuardNullcheck, got {type(guard)}"
    assert guard.is_null is False, f"Expected is_null=False"
    assert guard.expr.path == ["ctx", "token"], f"Expected path ['ctx', 'token'], got {guard.expr.path}"


def test_parse_nullcheck_eq():
    defn = parse_orca_md(orca_md("ctx.value == null"))
    guard = defn.guards["g"]
    assert isinstance(guard, GuardNullcheck), f"Expected GuardNullcheck, got {type(guard)}"
    assert guard.is_null is True, f"Expected is_null=True"


def test_parse_and():
    defn = parse_orca_md(orca_md("ctx.a > 1 and ctx.b < 10", "a"))
    guard = defn.guards["g"]
    assert isinstance(guard, GuardAnd), f"Expected GuardAnd, got {type(guard)}"
    assert isinstance(guard.left, GuardCompare), f"Expected left GuardCompare"
    assert isinstance(guard.right, GuardCompare), f"Expected right GuardCompare"


def test_parse_or():
    defn = parse_orca_md(orca_md("ctx.a == 1 or ctx.b == 2", "a"))
    guard = defn.guards["g"]
    assert isinstance(guard, GuardOr), f"Expected GuardOr, got {type(guard)}"


def test_parse_not():
    defn = parse_orca_md(orca_md("not ctx.allowed"))
    guard = defn.guards["g"]
    assert isinstance(guard, GuardNot), f"Expected GuardNot, got {type(guard)}"


def test_parse_compare_ge():
    defn = parse_orca_md(orca_md("ctx.score >= 100", "score"))
    guard = defn.guards["g"]
    assert isinstance(guard, GuardCompare), f"Expected GuardCompare, got {type(guard)}"
    assert guard.op == "ge", f"Expected op 'ge', got '{guard.op}'"


def test_parse_string_compare():
    defn = parse_orca_md(orca_md('ctx.status == "pending"', "status"))
    guard = defn.guards["g"]
    assert isinstance(guard, GuardCompare), f"Expected GuardCompare, got {type(guard)}"
    assert guard.op == "eq", f"Expected op 'eq', got '{guard.op}'"
    assert guard.right.value == "pending", f"Expected value 'pending', got {guard.right.value}"


# ---- Evaluator tests ----

async def _test_eval_compare_pass():
    defn = parse_orca_md(orca_md("ctx.retry_count < 3", "retry_count"))
    machine = OrcaMachine(defn, event_bus=EventBus(), context={"retry_count": 1})
    await machine.start()
    result = await machine.send("GO")
    assert result.taken is True, f"Expected transition taken, got: {result.error}"
    assert result.to_state == "done", f"Expected state 'done', got '{result.to_state}'"


async def _test_eval_compare_fail():
    defn = parse_orca_md(orca_md("ctx.retry_count < 3", "retry_count"))
    machine = OrcaMachine(defn, event_bus=EventBus(), context={"retry_count": 5})
    await machine.start()
    result = await machine.send("GO")
    assert result.taken is False, f"Expected transition NOT taken"
    assert result.guard_failed is True, f"Expected guard_failed"


async def _test_eval_nullcheck_pass():
    defn = parse_orca_md(orca_md("ctx.token != null", "token"))
    machine = OrcaMachine(defn, event_bus=EventBus(), context={"token": "abc123"})
    await machine.start()
    result = await machine.send("GO")
    assert result.taken is True, f"Expected transition taken, got: {result.error}"


async def _test_eval_nullcheck_fail():
    defn = parse_orca_md(orca_md("ctx.token != null", "token"))
    machine = OrcaMachine(defn, event_bus=EventBus(), context={"token": None})
    await machine.start()
    result = await machine.send("GO")
    assert result.taken is False, f"Expected transition NOT taken"
    assert result.guard_failed is True, f"Expected guard_failed"


async def _test_eval_and_both_true():
    defn = parse_orca_md(orca_md("ctx.a > 1 and ctx.b < 10", "a"))
    machine = OrcaMachine(defn, event_bus=EventBus(), context={"a": 5, "b": 3})
    await machine.start()
    result = await machine.send("GO")
    assert result.taken is True, f"Expected transition taken, got: {result.error}"


async def _test_eval_and_one_false():
    defn = parse_orca_md(orca_md("ctx.a > 1 and ctx.b < 10", "a"))
    machine = OrcaMachine(defn, event_bus=EventBus(), context={"a": 0, "b": 3})
    await machine.start()
    result = await machine.send("GO")
    assert result.taken is False, f"Expected transition NOT taken"


async def _test_eval_or_one_true():
    defn = parse_orca_md(orca_md("ctx.a == 1 or ctx.b == 2", "a"))
    machine = OrcaMachine(defn, event_bus=EventBus(), context={"a": 99, "b": 2})
    await machine.start()
    result = await machine.send("GO")
    assert result.taken is True, f"Expected transition taken, got: {result.error}"


async def _test_eval_or_both_false():
    defn = parse_orca_md(orca_md("ctx.a == 1 or ctx.b == 2", "a"))
    machine = OrcaMachine(defn, event_bus=EventBus(), context={"a": 99, "b": 99})
    await machine.start()
    result = await machine.send("GO")
    assert result.taken is False, f"Expected transition NOT taken"


async def _test_eval_not_null_is_true():
    defn = parse_orca_md(orca_md("not ctx.blocked"))
    machine = OrcaMachine(defn, event_bus=EventBus(), context={"blocked": None})
    await machine.start()
    result = await machine.send("GO")
    assert result.taken is True, f"Expected transition taken, got: {result.error}"


async def _test_eval_not_present_is_false():
    defn = parse_orca_md(orca_md("not ctx.blocked"))
    machine = OrcaMachine(defn, event_bus=EventBus(), context={"blocked": "yes"})
    await machine.start()
    result = await machine.send("GO")
    assert result.taken is False, f"Expected transition NOT taken"


async def _test_eval_string_compare_pass():
    defn = parse_orca_md(orca_md('ctx.status == "pending"', "status"))
    machine = OrcaMachine(defn, event_bus=EventBus(), context={"status": "pending"})
    await machine.start()
    result = await machine.send("GO")
    assert result.taken is True, f"Expected transition taken, got: {result.error}"


async def _test_eval_string_compare_fail():
    defn = parse_orca_md(orca_md('ctx.status == "pending"', "status"))
    machine = OrcaMachine(defn, event_bus=EventBus(), context={"status": "active"})
    await machine.start()
    result = await machine.send("GO")
    assert result.taken is False, f"Expected transition NOT taken"


async def _test_eval_compare_ge():
    defn = parse_orca_md(orca_md("ctx.score >= 100", "score"))
    machine = OrcaMachine(defn, event_bus=EventBus(), context={"score": 100})
    await machine.start()
    result = await machine.send("GO")
    assert result.taken is True, f"Expected transition taken, got: {result.error}"


async def _test_eval_true_literal():
    defn = parse_orca_md(orca_md("true"))
    machine = OrcaMachine(defn, event_bus=EventBus())
    await machine.start()
    result = await machine.send("GO")
    assert result.taken is True, f"Expected transition taken, got: {result.error}"


async def _test_eval_false_literal():
    defn = parse_orca_md(orca_md("false"))
    machine = OrcaMachine(defn, event_bus=EventBus())
    await machine.start()
    result = await machine.send("GO")
    assert result.taken is False, f"Expected transition NOT taken"
    assert result.guard_failed is True, f"Expected guard_failed"


# ---- Sync test wrappers ----

def test_eval_compare_pass():
    asyncio.run(_test_eval_compare_pass())

def test_eval_compare_fail():
    asyncio.run(_test_eval_compare_fail())

def test_eval_nullcheck_pass():
    asyncio.run(_test_eval_nullcheck_pass())

def test_eval_nullcheck_fail():
    asyncio.run(_test_eval_nullcheck_fail())

def test_eval_and_both_true():
    asyncio.run(_test_eval_and_both_true())

def test_eval_and_one_false():
    asyncio.run(_test_eval_and_one_false())

def test_eval_or_one_true():
    asyncio.run(_test_eval_or_one_true())

def test_eval_or_both_false():
    asyncio.run(_test_eval_or_both_false())

def test_eval_not_null_is_true():
    asyncio.run(_test_eval_not_null_is_true())

def test_eval_not_present_is_false():
    asyncio.run(_test_eval_not_present_is_false())

def test_eval_string_compare_pass():
    asyncio.run(_test_eval_string_compare_pass())

def test_eval_string_compare_fail():
    asyncio.run(_test_eval_string_compare_fail())

def test_eval_compare_ge():
    asyncio.run(_test_eval_compare_ge())

def test_eval_true_literal():
    asyncio.run(_test_eval_true_literal())

def test_eval_false_literal():
    asyncio.run(_test_eval_false_literal())


if __name__ == "__main__":
    tests = [
        # Parser tests
        ("parse true literal", test_parse_true),
        ("parse false literal", test_parse_false),
        ("parse compare expression", test_parse_compare),
        ("parse nullcheck (!=)", test_parse_nullcheck_ne),
        ("parse nullcheck (==)", test_parse_nullcheck_eq),
        ("parse and expression", test_parse_and),
        ("parse or expression", test_parse_or),
        ("parse not expression", test_parse_not),
        ("parse compare >=", test_parse_compare_ge),
        ("parse string compare", test_parse_string_compare),
        # Evaluator tests
        ("eval compare pass (1 < 3)", test_eval_compare_pass),
        ("eval compare fail (5 < 3)", test_eval_compare_fail),
        ("eval nullcheck pass (token present)", test_eval_nullcheck_pass),
        ("eval nullcheck fail (token null)", test_eval_nullcheck_fail),
        ("eval and (both true)", test_eval_and_both_true),
        ("eval and (one false)", test_eval_and_one_false),
        ("eval or (one true)", test_eval_or_one_true),
        ("eval or (both false)", test_eval_or_both_false),
        ("eval not (null value = true)", test_eval_not_null_is_true),
        ("eval not (present value = false)", test_eval_not_present_is_false),
        ("eval string compare pass", test_eval_string_compare_pass),
        ("eval string compare fail", test_eval_string_compare_fail),
        ("eval compare >= boundary", test_eval_compare_ge),
        ("eval true literal", test_eval_true_literal),
        ("eval false literal", test_eval_false_literal),
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
