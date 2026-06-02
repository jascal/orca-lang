# QA Report — Python Runtime (`packages/runtime-python`)

**Date:** 2026-06-02
**Verified against:** `origin/main` `bf76c67` (v0.1.28). The implicated files are
byte-identical at the local `1743f37`, so line numbers below are stable for both.
**Scope:** `packages/runtime-python/orca_runtime_python/machine.py` (+ the guard
grammar in `packages/orca-lang/src/parser/markdown-parser.ts` and the Python
parser).
**Method:** every issue below was reproduced end-to-end through the real runtime
(`parse_orca_md` + `OrcaMachine`), not judged by reading alone. Repro scripts are
inlined and convert directly into regression tests.

## Provenance / caveat

This report originated while triaging an external bug list ("Hermes"). That list
also contained a tier of TypeScript-verifier findings (BUG-01..05, 08, 13, C-01)
that were investigated and **did not reproduce** at `bf76c67` — `StateDef` is
camelCase as `structural.ts` reads it, `MachineDef.effects` exists and is
populated, `flattenStates` has no duplicate push, `checkReachability` iterates the
flattened state map, and the TS verifier/parser **are** tested (`verifier.test.ts`,
`markdown-parser.test.ts`; 109 passing). **Do not action those.** This report is
scoped to the Python-runtime findings, which are real.

## Summary

| ID | Issue | Severity | Status |
|----|-------|----------|--------|
| RT-06 | `on_entry` silently dropped when a state also has `invoke` | MEDIUM | **Fixed** (regression test) |
| RT-07 | `resume()` / `restore()` drop child machines **and** `active_invoke` | MEDIUM-HIGH | **Fixed** (regression test) |
| RT-12 | `event.*` guards parse but are unresolvable — events never in guard scope | HIGH | **Fixed** (regression test) |
| RT-14 | Ordered guard comparisons (`<`,`>`,`<=`,`>=`) fall back to string compare on non-numeric / `None` → fail **open** | MEDIUM | **Fixed** (regression test) |

**Resolution (2026-06-02):** All four fixed in `packages/runtime-python/orca_runtime_python/machine.py`,
with regression tests in `packages/runtime-python/tests/test_qa_fixes.py` (10 tests) and the fixes
documented in `docs/runtime-python-production-hardening.md`. RT-12 + RT-14 were fixed together (RT-14
masked RT-12). Full suite: 116 passed.

Severities are re-ranked from the source list: RT-12 fails *open* (a guard passes
when it should deny), which is a correctness/security landmine, not "LOW".

None of these four paths are covered by the existing suite (no test combines
`invoke` + `on_entry`; `test_snapshot_restore.py` never reads `children` /
`active_invoke`; no `event.*` guard test). Current suite: 104 passed; the 2
`test_bridge.py` failures are environmental (`async def` tests need
`pytest-asyncio`), not regressions.

---

## RT-06 — `on_entry` dropped when a state also declares `invoke`

**Location:** `machine.py:835-844`, `_execute_entry_actions`.

```python
async def _execute_entry_actions(self, state_name: str) -> None:
    state_def = self._find_state_def(state_name)
    if not state_def:
        return
    if state_def.invoke:
        await self.start_child_machine(state_name, state_def.invoke)
        return                      # <-- on_entry is never reached
    if not state_def.on_entry:
        return
    ...
```

**Root cause:** the `invoke` branch returns early, so a state with both `invoke`
and `on_entry` silently discards `on_entry`. Intentional in code, but undocumented
and contrary to XState semantics (entry actions run **before** services are
invoked).

**Repro:**
```python
PARENT = """# machine Parent
## events
- E
## state working [initial]
- invoke: Child
- on_entry: mark_entry
## state idle [final]
## transitions
| Source | Event | Target |
|--------|-------|--------|
| working | E | idle |
"""
m = OrcaMachine(parse_orca_md(PARENT)); m.register_machines({"Child": child_def})
calls = []; m.register_action("mark_entry", lambda ctx, ev: calls.append(1))
await m.start()
# observed: calls == []  (on_entry NOT fired), child started, active_invoke == "working"
```

**Impact:** any state that both conditions a child machine and runs an entry
action loses the entry action with no error or warning.

**Proposed fix:** run the `on_entry` action first, then start the invoke — i.e.
drop the early `return` and fall through to the on_entry block before (or after,
per chosen semantics, but XState says before) `start_child_machine`. Document the
ordering.

**Regression test:** assert `mark_entry` ran exactly once *and* the child started.

---

## RT-07 — `resume()` / `restore()` lose child machines and `active_invoke`

**Location:** `snapshot()` `machine.py:143-161`; `resume()` `:204-245`;
`restore()` `:163-179`.

`snapshot()` persists the relevant state:
```python
"children": {k: m.snapshot() for k, m in self._child_machines.items()},   # :158
"active_invoke": self._active_invoke,                                      # :159
```
…but `resume()` (and `restore()`) restore only `_state`, `context`, and timeouts.
They **never read `snap["children"]` or `snap["active_invoke"]`**.

**Repro:**
```python
snap = parent.snapshot()
# snap["children"] == {"working": {...}},  snap["active_invoke"] == "working"
m2 = OrcaMachine(pdef); m2.register_machines({"Child": cdef})
await m2.resume(snap)
# observed: m2.state.value == "working"   (an invoke state)
#           m2._child_machines == {}       (child NOT re-instantiated)
#           m2._active_invoke is None       (invoke marker lost)
```

**Impact:** a machine that crashes inside an `invoke` state resumes *in* that state
with no child running and `active_invoke=None`. Nothing will ever drive it to
`on_done` → the machine is permanently stalled. This is worse than "child machines
are lost": the parent is wedged. Affects the production resume/persistence path.

**Proposed fix (touches the resume contract — confirm before implementing):**
in `resume()`/`restore()`, after restoring state/context:
1. restore `self._active_invoke = snap.get("active_invoke")`;
2. for each `state_name, child_snap` in `snap.get("children", {})`, re-instantiate
   the child `OrcaMachine` from the sibling definition, re-attach the completion
   `on_transition` handler used in `start_child_machine`, and `resume(child_snap)`
   it (recursive).
   - Requires sibling defs (`register_machines`) and action handlers to be
     re-registered *before* resume — document this precondition.
3. Decide handling when a child snapshot exists but its sibling def isn't
   registered (warn vs raise).

**Regression test:** snapshot a parent in an invoke state with a live child →
`resume()` into a fresh parent → assert the child is rehydrated and
`active_invoke` is restored.

---

## RT-12 — `event.*` guards are writable but silently unresolvable

**Location:** grammar `packages/orca-lang/src/parser/markdown-parser.ts:313-316`
(`parseVariablePath` accepts any `IDENT(.IDENT)*`); the Python parser likewise.
Evaluation: `_evaluate_guard(self, guard_name)` `machine.py:754` takes **no event**;
`_resolve_variable` `:782-795` walks `self.context` only.

```python
def _resolve_variable(self, ref):
    current = self.context
    for part in ref.path:
        if part in ("ctx", "context"):   # only these prefixes are special-cased
            continue
        ...
        current = current.get(part) if isinstance(current, dict) else getattr(current, part, None)
    return current
```

A guard `event.amount > 100` parses to `path = ["event", "amount"]`, but the event
is never in scope, so it resolves to `context["event"]` → `None`.

**Repro:**
```python
GUARD = "`event.amount > 100`"   # in a ## guards table, used by idle--PAY-->approved
m = OrcaMachine(parse_orca_md(...))
await m.start(); await m.send("PAY", {"amount": 5})
# observed: state == "approved"   (should be "denied"; the event payload is ignored)
# m._resolve_variable(<event.amount ref>) == None
```
Both `amount=5` and `amount=200` → `approved`, i.e. the guard is insensitive to the
payload entirely. (The spurious *pass* is due to RT-14 below.)

**Impact:** guards that reference event payloads compile and run but ignore the
event — and, via RT-14, tend to **pass** rather than fail. Silent, fail-open
incorrect routing. This is the most dangerous of the four.

**Proposed fix:** thread the triggering `Event` through guard evaluation
(`_evaluate_guard` / `_eval_guard` / `_eval_compare` / `_resolve_variable`) and
resolve a leading `event` / `payload` segment against the event's payload. If
event-referencing guards are *not* intended to be supported, the parser must
**reject** them rather than silently mis-resolve.

**Regression test:** `event.amount > 100` with payload `amount=5` → `denied`;
`amount=200` → `approved`.

---

## RT-14 — Ordered comparisons fall back to string compare and fail open

**Location:** `_eval_compare` `machine.py:801-827`.

```python
try:
    lnum = float(lhs) ...; rnum = float(rhs) ...; both_numeric = True
except (TypeError, ValueError):
    both_numeric = False
...
if op == "gt":
    return lnum > rnum if both_numeric else str(lhs) > str(rhs)   # <-- lexicographic fallback
```

**Root cause:** when an operand isn't numeric (e.g. an unset/`None` context field, or
a non-numeric value), `<`,`>`,`<=`,`>=` silently compare `str(lhs)` vs `str(rhs)`.
So `<None> > 100` becomes `"None" > "100"` → `True`.

**Repro:** this is what makes RT-12's broken guard return `approved` — `str(None) >
str(100)` is `True`. Independently, any ordered guard over a missing/null context
field passes spuriously.

**Impact:** ordered guards on null/unset/non-numeric values fail **open** (pass
when they should not). Easy to hit with an uninitialized context field.

**Proposed fix:** for ordered comparisons, treat a non-numeric/`None` operand as the
guard being **false** (do not silently fall back to lexicographic compare), or
raise a typed guard-evaluation error. Keep `eq`/`ne` as-is (equality on mixed types
is well-defined). Document the chosen semantics in `docs/error-catalog.md`.

**Regression test:** guard `ctx.x > 100` with `x` unset/`None` → guard is `False`.

---

## Suggested order & acceptance

1. **RT-12 + RT-14** together (they interact; RT-14 masks RT-12). Acceptance: the
   RT-12 repro routes correctly for both payloads; null-operand ordered guards
   evaluate `False`.
2. **RT-06.** Acceptance: `on_entry` fires once before/with `invoke`; documented.
3. **RT-07.** Acceptance: round-trip snapshot→resume of an invoke-state machine
   rehydrates the child and `active_invoke`. **Confirm the resume/persistence
   contract change first** (re-registration preconditions, missing-sibling policy).

All four come with the repros above; lifting them into
`tests/test_*.py` closes the coverage gap that let these ship.
