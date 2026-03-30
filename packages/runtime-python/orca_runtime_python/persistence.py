"""
Pluggable persistence adapters for Orca machine state.

PersistenceAdapter is a Protocol — any object implementing save/load/exists
can be used. FilePersistence is the bundled default (zero extra dependencies).

Usage:
    from orca_runtime_python import FilePersistence

    fp = FilePersistence("./runs")
    await run_pipeline(machines, ctx, persistence=fp, run_id="exp-001")
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Protocol, runtime_checkable


@runtime_checkable
class PersistenceAdapter(Protocol):
    """
    Synchronous persistence adapter. Suitable for local file I/O.

    Implementations must support three operations keyed by run_id:
    save, load (returns None if not found), and exists.
    """

    def save(self, run_id: str, snapshot: dict[str, Any]) -> None:
        """Persist snapshot under run_id. Overwrites any prior snapshot."""
        ...

    def load(self, run_id: str) -> dict[str, Any] | None:
        """Return the snapshot for run_id, or None if it doesn't exist."""
        ...

    def exists(self, run_id: str) -> bool:
        """Return True if a snapshot exists for run_id."""
        ...


@runtime_checkable
class AsyncPersistenceAdapter(Protocol):
    """
    Async persistence adapter for database and network backends.

    Drop-in replacement for PersistenceAdapter when using async drivers
    (asyncpg, aioredis, aiobotocore, etc.). OrcaMachine accepts either.
    """

    async def save(self, run_id: str, snapshot: dict[str, Any]) -> None:
        """Persist snapshot under run_id. Overwrites any prior snapshot."""
        ...

    async def load(self, run_id: str) -> dict[str, Any] | None:
        """Return the snapshot for run_id, or None if it doesn't exist."""
        ...

    async def exists(self, run_id: str) -> bool:
        """Return True if a snapshot exists for run_id."""
        ...


class FilePersistence:
    """
    File-based persistence adapter.

    Snapshots are stored as JSON files under base_dir:
        {base_dir}/{run_id}.json

    Writes are atomic: the file is written to a .tmp sibling and then
    renamed, so a crash mid-write leaves the previous snapshot intact.

    Example:
        fp = FilePersistence("./runs")
        fp.save("exp-001", machine.snapshot())
        snap = fp.load("exp-001")   # dict or None
    """

    def __init__(self, base_dir: str | Path):
        self._base = Path(base_dir)

    def _path(self, run_id: str) -> Path:
        return self._base / f"{run_id}.json"

    def save(self, run_id: str, snapshot: dict[str, Any]) -> None:
        """Write snapshot atomically. Creates base_dir if needed."""
        self._base.mkdir(parents=True, exist_ok=True)
        target = self._path(run_id)
        tmp = target.with_suffix(".tmp")
        tmp.write_text(json.dumps(snapshot, indent=2, default=str))
        os.replace(tmp, target)

    def load(self, run_id: str) -> dict[str, Any] | None:
        """Return snapshot dict, or None if run_id has no saved state."""
        path = self._path(run_id)
        if not path.exists():
            return None
        return json.loads(path.read_text())

    def exists(self, run_id: str) -> bool:
        """True if a snapshot exists for run_id."""
        return self._path(run_id).exists()
