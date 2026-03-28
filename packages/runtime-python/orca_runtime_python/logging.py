"""
Pluggable log sinks for Orca machine audit trails.

LogSink is a Protocol — any object implementing write/close can be used.
Three sinks are bundled:

  FileSink    — JSONL file, one entry per line, append-safe for resume
  ConsoleSink — human-readable transitions printed to stdout
  MultiSink   — fan-out to multiple sinks simultaneously

Usage:
    from orca_runtime_python import FileSink, ConsoleSink, MultiSink

    sink = MultiSink(
        FileSink("./runs/exp-001/audit.jsonl"),
        ConsoleSink(),
    )
    await run_pipeline(machines, ctx, run_id="exp-001", log_sink=sink)
    sink.close()

Log entry format (dict written to each sink):
    {
        "ts":            "2026-03-27T10:15:32.123456Z",
        "run_id":        "exp-001",
        "machine":       "TrainingLab",
        "event":         "DATA_READY",
        "from":          "data_prep",
        "to":            "hyper_search",
        "context_delta": {"vocab_size": 65, "train_tokens": 900000}
    }
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol, runtime_checkable


@runtime_checkable
class LogSink(Protocol):
    """Protocol for Orca audit log destinations."""

    def write(self, entry: dict[str, Any]) -> None:
        """Record a single log entry."""
        ...

    def close(self) -> None:
        """Flush and release any held resources."""
        ...


class FileSink:
    """
    Appends log entries as newline-delimited JSON (JSONL) to a file.

    Opens in append mode so resumed runs extend the same audit log
    rather than overwriting it.

    Example:
        sink = FileSink("./runs/exp-001/audit.jsonl")
        sink.write({"event": "DATA_READY", ...})
        sink.close()
    """

    def __init__(self, path: str | Path):
        self._path = Path(path)
        self._f = None

    def _ensure_open(self) -> None:
        if self._f is None:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            self._f = open(self._path, "a", encoding="utf-8")

    def write(self, entry: dict[str, Any]) -> None:
        self._ensure_open()
        self._f.write(json.dumps(entry, default=str) + "\n")  # type: ignore[union-attr]
        self._f.flush()  # type: ignore[union-attr]

    def close(self) -> None:
        if self._f is not None:
            self._f.close()
            self._f = None


class ConsoleSink:
    """
    Prints a compact, human-readable line for each transition.

    Format:
        [HH:MM:SS] Machine  from → to  (EVENT)  key=val key=val
    """

    def __init__(self, file=None):
        self._file = file or sys.stdout

    def write(self, entry: dict[str, Any]) -> None:
        ts = entry.get("ts", "")
        time_part = ts[11:19] if len(ts) >= 19 else ts  # HH:MM:SS
        machine = entry.get("machine", "")
        from_s = entry.get("from", "?")
        to_s = entry.get("to", "?")
        event = entry.get("event", "")
        delta = entry.get("context_delta", {})

        delta_str = "  " + "  ".join(
            f"{k}={v}" for k, v in delta.items()
            if k != "error_message" or v
        ) if delta else ""

        event_str = f"  ({event})" if event else ""
        print(
            f"[{time_part}] {machine:<14} {from_s} → {to_s}{event_str}{delta_str}",
            file=self._file,
        )

    def close(self) -> None:
        pass


class MultiSink:
    """
    Fan-out sink that writes each entry to multiple sinks.

    Example:
        sink = MultiSink(FileSink("audit.jsonl"), ConsoleSink())
    """

    def __init__(self, *sinks: LogSink):
        self._sinks = list(sinks)

    def write(self, entry: dict[str, Any]) -> None:
        for sink in self._sinks:
            sink.write(entry)

    def close(self) -> None:
        for sink in self._sinks:
            sink.close()


def _make_entry(
    *,
    run_id: str,
    machine: str,
    event: str,
    from_state: str,
    to_state: str,
    context_delta: dict[str, Any],
) -> dict[str, Any]:
    """Build a standard log entry dict."""
    return {
        "ts": datetime.now(timezone.utc).isoformat(),
        "run_id": run_id,
        "machine": machine,
        "event": event,
        "from": from_state,
        "to": to_state,
        "context_delta": context_delta,
    }
