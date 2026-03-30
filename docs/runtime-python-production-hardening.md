# Python Runtime: Production Hardening

## Motivation

The Python runtime was developed alongside the ML pipeline and agent demos (demo-python, demo-nanolab). Those workloads share a common shape: a single-process script starts a machine, drives it to completion, and exits. The persistence adapter writes a file. If anything goes wrong, the operator reruns the script.

As `orca-runtime-python` gets adopted for production server workloads — async web backends, message queue consumers, multi-tenant SaaS systems, long-running workflow engines — a set of gaps has become apparent. The gaps are not visible in demo usage but surface immediately in server deployments:

1. Snapshots do not record which machine they belong to, making external storage fragile.
2. Sending an event to an unstarted machine fails silently, making initialization races undetectable.
3. The `PersistenceAdapter` Protocol is synchronous, incompatible with async database drivers.
4. There is no mechanism to detect stale snapshots when a machine definition evolves.

None of these require redesigning the runtime. Each is a focused addition. The changes are ranked by the severity of the gap they close.

---

## Gap 1 — Snapshot does not record machine name

**Classification: Required fix**

### Problem

`OrcaMachine.snapshot()` returns:

```python
{
    "state": "...",
    "context": {...},
    "children": {...},
    "active_invoke": "...",
    "timestamp": 1234567890.0,
}
```

The machine's name (`definition.name`) is absent. Any system that stores snapshots outside the process — in a database, a key-value store, on S3 — must track the machine name separately. If that association is lost or a bug mismismatches a snapshot with the wrong machine definition, `OrcaMachine.resume()` restores into a structurally inconsistent state with no error raised.

This is already inconsistent with the logging system: `LogSink` entries (see `logging.py`) include `"machine": "TrainingLab"` for exactly this reason — so that log records are self-describing. Snapshots should be too.

### Proposed change

Add a `"machine"` key to the snapshot dict:

```python
# machine.py — snapshot()
def snapshot(self) -> dict[str, Any]:
    import copy, time
    state_val = self._state.value
    return {
        "machine": self.definition.name,           # ← add
        "state": copy.deepcopy(state_val),
        "context": copy.deepcopy(self.context),
        "children": {k: m.snapshot() for k, m in self._child_machines.items()},
        "active_invoke": self._active_invoke,
        "timestamp": time.time(),
    }
```

**Backward compatibility**: additive. Existing consumers that do not read `"machine"` are unaffected. Existing snapshots without the key can still be restored — `resume()` does not require it.

**Downstream**: `restore()` and `resume()` can optionally assert that `snap.get("machine") == self.definition.name` and warn (or raise) on mismatch. This is a separate, optional guard.

---

## Gap 2 — `send()` before `start()` drops events silently

**Classification: Required fix**

### Problem

In long-running server processes, machine initialization and event delivery can race. Consider:

- A machine is created for an incoming webhook, but an async callback from a slow external service arrives before `start()` completes.
- A message queue consumer picks up a "job complete" message for a machine that is being restored from a database snapshot — `resume()` is async and can yield between queue delivery and completion.
- A machine is started in one coroutine while an unrelated timer fires `send()` on it from another.

The current behavior:

```python
async def send(self, event, payload=None) -> TransitionResult:
    if not self._active:
        return TransitionResult(
            taken=False,
            from_state=str(self._state),
            error="Machine is not active"
        )
```

The caller receives a `TransitionResult` that looks like a normal guard failure. Nothing is logged. The event is silently dropped. Debugging this class of bug requires knowing to look for `taken=False` with `error="Machine is not active"`, which is not obvious.

### Proposed change

Introduce a dedicated exception class and raise it:

```python
class MachineNotActiveError(RuntimeError):
    """
    Raised when send() is called on a machine that has not been started
    or has already been stopped.

    Always indicates a caller-side sequencing error. The fix is to ensure
    start() or resume() completes before any send() call reaches this machine.
    """
    pass
```

Update `send()`:

```python
async def send(self, event, payload=None) -> TransitionResult:
    if not self._active:
        raise MachineNotActiveError(
            f"Machine '{self.definition.name}' is not active. "
            "Call start() or resume() before sending events."
        )
    # ... rest of send() unchanged
```

**Why raise rather than return**: `TransitionResult` is the result of a deliberate event dispatch. A caller that sends `ORDER_SHIPPED` to a machine does not expect that it might silently be told "not taken" because the machine hasn't started yet. That condition is a programming error in the caller, not a business-logic outcome. Exceptions surface programming errors; result values communicate business outcomes.

**Backward compatibility**: any caller that currently catches the `taken=False, error="..."` pattern from pre-start sends will stop seeing that response and instead receive an exception. The old behavior was already incorrect — callers that were silently swallowing these failures were not handling the race correctly in any case.

**Migration**: callers that want to queue events until a machine is active should do so at the application layer, not inside the runtime. A registry that gates on `machine.is_active` before calling `send()` is the correct pattern.

---

## Gap 3 — `PersistenceAdapter` Protocol is synchronous

**Classification: Recommended**

### Problem

The `PersistenceAdapter` Protocol (`persistence.py`) defines three synchronous methods:

```python
@runtime_checkable
class PersistenceAdapter(Protocol):
    def save(self, run_id: str, snapshot: dict[str, Any]) -> None: ...
    def load(self, run_id: str) -> dict[str, Any] | None: ...
    def exists(self, run_id: str) -> bool: ...
```

This works correctly for `FilePersistence` (local file I/O). It does not work for any networked or database backend:

- **PostgreSQL** — `asyncpg`, `psycopg3`, `SQLAlchemy async` are all `async/await` native.
- **Redis** — `aioredis` / `redis.asyncio` are async.
- **AWS S3** — `aiobotocore` is async.
- **Memcached, DynamoDB, Firestore** — all async Python drivers.

The workaround is `asyncio.get_event_loop().run_until_complete()` inside the sync stubs. This raises `RuntimeError: This event loop is already running` in any async server framework (FastAPI, Starlette, Django async, AIOHTTP, Tornado) — exactly the environments where production machines run.

The only safe workaround is `asyncio.to_thread()`, which moves the sync call to a thread pool. For a database that already has an async driver, running it through a thread pool defeats the purpose and adds latency.

### Proposed change

Add a parallel async Protocol:

```python
# persistence.py

@runtime_checkable
class PersistenceAdapter(Protocol):
    """Synchronous persistence adapter. Suitable for local file I/O."""
    def save(self, run_id: str, snapshot: dict[str, Any]) -> None: ...
    def load(self, run_id: str) -> dict[str, Any] | None: ...
    def exists(self, run_id: str) -> bool: ...


@runtime_checkable
class AsyncPersistenceAdapter(Protocol):
    """Async persistence adapter for database and network backends."""
    async def save(self, run_id: str, snapshot: dict[str, Any]) -> None: ...
    async def load(self, run_id: str) -> dict[str, Any] | None: ...
    async def exists(self, run_id: str) -> bool: ...
```

Update `OrcaMachine.__init__` to accept either:

```python
def __init__(
    self,
    definition: MachineDef,
    event_bus: EventBus | None = None,
    context: dict[str, Any] | None = None,
    on_transition: TransitionCallback | None = None,
    persistence: PersistenceAdapter | AsyncPersistenceAdapter | None = None,
    run_id: str | None = None,
):
```

When `persistence` and `run_id` are provided, `OrcaMachine` calls `persistence.save()` (or `await persistence.save()`, detected via `asyncio.iscoroutinefunction`) after each transition, and calls `persistence.load()` in a new `load_or_start()` convenience method:

```python
async def load_or_start(self) -> None:
    """
    If a snapshot exists for self._run_id, resume from it.
    Otherwise, start fresh.
    Replaces the pattern: check persistence, call resume() or start() manually.
    """
    if self._persistence and self._run_id:
        snap = await self._load_snapshot()
        if snap:
            await self.resume(snap)
            return
    await self.start()
```

**Note on existing demos**: demos that pass `FilePersistence` explicitly (demo-nanolab, demo-go) continue to work without change. The new `AsyncPersistenceAdapter` Protocol is additive.

**Auto-save on transition**: when `persistence` is set, the runtime calls `save()` inside `on_transition` automatically. This removes the need for callers to implement save logic in their own `on_transition` callbacks — a common source of missed saves when an on_transition callback throws.

---

## Gap 4 — No mechanism to detect stale snapshots

**Classification: Recommended**

### Problem

Machine definitions evolve: states get renamed, transitions are added or removed, guard names change. A snapshot captured against version N of a machine definition may be invalid against version N+1. Currently:

- There is no version field in `MachineDef`.
- There is no version field in snapshots.
- `resume()` restores unconditionally — it does not check whether the stored state name exists in the current definition.
- If a restored state no longer exists, the machine accepts events but can never find a matching transition, producing silent `taken=False` results indefinitely.

For short-lived scripts this is not a concern. For long-running production workflows where a machine may be in-flight for hours or days across multiple server deployments, this is a real operational risk.

### Proposed change

Add a `version` field to `MachineDef`:

```python
@dataclass
class MachineDef:
    name: str
    context: dict[str, Any]
    events: list[str]
    states: list[StateDef]
    transitions: list[Transition]
    guards: dict[str, GuardExpression] = field(default_factory=dict)
    actions: list[ActionSignature] = field(default_factory=list)
    effects: list[EffectDef] = field(default_factory=list)
    version: str = "0.1.0"    # ← add
```

The parser reads the version from a `version:` bullet in the machine heading block, if present:

```markdown
# machine PaymentProcessor
- version: 1.2.0
```

If absent, the default `"0.1.0"` is used (backward compatible).

Include `definition_version` in snapshots:

```python
def snapshot(self) -> dict[str, Any]:
    return {
        "machine": self.definition.name,
        "definition_version": self.definition.version,   # ← add
        "state": ...,
        ...
    }
```

Add a version check in `resume()`:

```python
async def resume(self, snap: dict[str, Any]) -> None:
    snap_version = snap.get("definition_version", "0.1.0")
    if snap_version != self.definition.version:
        import warnings
        warnings.warn(
            f"Snapshot version '{snap_version}' does not match "
            f"machine definition version '{self.definition.version}' "
            f"for machine '{self.definition.name}'. "
            "The snapshot may be incompatible with the current definition.",
            UserWarning,
            stacklevel=2,
        )
    # ... rest of resume() unchanged
```

A warning (not an error) is appropriate: some definition changes are backward-compatible (adding new states and transitions does not invalidate existing snapshots), and callers may have migration logic to handle specific version transitions. Surfacing the mismatch as a warning lets callers decide whether to treat it as fatal.

---

## Minor improvements

These do not close critical gaps, but improve ergonomics and are low-cost to add.

### M-1. `parse_orca_md` should raise on structurally invalid input

**File**: `parser.py`

Currently, malformed `.orca.md` files often produce an empty or incomplete `MachineDef` rather than a `ParseError`. A misspelled section heading silently produces a machine with no transitions; a missing `[initial]` annotation produces a machine that always defaults to its first state with no indication that something is wrong.

Add post-parse validation:

```python
def _validate_machine_def(defn: MachineDef) -> None:
    if not defn.states:
        raise ParseError(f"Machine '{defn.name}': no states defined.")
    if not any(s.is_initial for s in defn.states):
        raise ParseError(f"Machine '{defn.name}': no [initial] state.")
    state_names = {s.name for s in defn.states}
    for t in defn.transitions:
        if t.source not in state_names:
            raise ParseError(f"Machine '{defn.name}': transition source '{t.source}' is not defined.")
        if t.target not in state_names:
            raise ParseError(f"Machine '{defn.name}': transition target '{t.target}' is not defined.")
        if t.guard and t.guard not in defn.guards:
            raise ParseError(f"Machine '{defn.name}': guard '{t.guard}' is used but not defined.")
```

Called at the end of `parse_orca_md()` and `parse_orca_md_multi()` before returning.

### M-2. `TransitionResult` should expose the leaf state name directly

**File**: `machine.py`

`TransitionResult.to_state` is `str(self._state)`, which produces dot-notation for compound states (`"processing.ocr_in_progress"`). Callers that only need the leaf state must either parse the string or call `machine.state.leaf()` immediately after `send()`. Add `to_state_leaf`:

```python
@dataclass
class TransitionResult:
    taken: bool
    from_state: str
    to_state: str | None = None
    to_state_leaf: str | None = None    # ← add
    guard_failed: bool = False
    error: str | None = None
```

Set in `send()`:
```python
return TransitionResult(
    taken=True,
    from_state=str(old_state),
    to_state=str(self._state),
    to_state_leaf=self._state.leaf(),   # ← add
)
```

### M-3. Document that `EFFECT_COMPLETED` payload carries the effect result

**File**: `README.md` (no code change)

When an `on_entry` action has `has_effect=True`, the effect result data is (a) merged into `context` and (b) included in the `EFFECT_COMPLETED` event's payload as `event.payload["result"]`. This second point is not documented anywhere. External systems that subscribe to the orca bus to observe effect outputs currently have no way to discover this without reading `machine.py:722–733`. Add a section to the README under "Effect Handlers" documenting the payload shape.

---

## Summary

| ID | Classification | File | Description |
|----|---------------|------|-------------|
| Gap 1 | **Required** | `machine.py` | Add `"machine"` key to `snapshot()` output |
| Gap 2 | **Required** | `machine.py` | Raise `MachineNotActiveError` on `send()` before `start()` |
| Gap 3 | Recommended | `persistence.py`, `machine.py` | `AsyncPersistenceAdapter` Protocol; `OrcaMachine` accepts either; auto-save on transition; `load_or_start()` convenience method |
| Gap 4 | Recommended | `types.py`, `machine.py`, `parser.py` | `MachineDef.version`; include in snapshots; warn on mismatch in `resume()` |
| M-1 | Minor | `parser.py` | Post-parse structural validation with informative `ParseError` messages |
| M-2 | Minor | `machine.py` | `to_state_leaf` field on `TransitionResult` |
| M-3 | Minor | `README.md` | Document `EFFECT_COMPLETED` event payload structure |

Gaps 1 and 2 should ship together — both are required for any deployment that persists machine state externally. Gaps 3 and 4 can follow independently. The minor improvements are best batched into a single small PR to avoid noise.
