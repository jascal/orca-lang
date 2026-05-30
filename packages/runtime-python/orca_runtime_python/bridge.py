"""Cross-tool composition bridge — orca's Python side.

Mirrors the q-orca ``bridge-protocol`` contract so a classical orca orchestrator
can invoke a q-orca quantum child (and orca can be invoked by q-orca). Three
versioned JSON envelopes; transport is process + JSON over each tool's ``run``
entry point. See orca-lang/docs/cross-tool-invoke-and-returns.md and q-orca's
openspec ``bridge-protocol`` spec.
"""

from __future__ import annotations

import json
import subprocess
from typing import Any

from .types import MachineDef

# Must match q-orca's BRIDGE_PROTOCOL_VERSION exactly.
BRIDGE_PROTOCOL_VERSION = "1.0"

_DEFAULT_TIMEOUT_S = 30


class BridgeError(Exception):
    """A bridge/transport failure (distinct from a child error in the envelope).

    Raised for: unlaunchable runner, timeout, non-JSON output, or an
    unsupported ``protocol_version``.
    """

    code = "BRIDGE_ERROR"


def _wire_type_from_value(value: Any) -> str:
    """Infer a wire type from a context default value.

    orca's MachineDef.context stores ``{name: default}`` without the declared
    type, so the descriptor infers it from the default (``any`` when unknown).
    """
    if isinstance(value, bool):
        return "bool"
    if isinstance(value, int):
        return "int"
    if isinstance(value, float):
        return "float"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "list"
    return "any"


def descriptor_for(machine: MachineDef) -> dict:
    """Emit a machine descriptor. orca machines are classical → measurement_bearing False."""
    return {
        "protocol_version": BRIDGE_PROTOCOL_VERSION,
        "name": machine.name,
        "params": [
            {"name": name, "type": _wire_type_from_value(default)}
            for name, default in machine.context.items()
        ],
        "returns": [
            {"name": r.name, "type": r.type, "statistics": list(r.statistics)}
            for r in machine.returns
        ],
        "measurement_bearing": False,
    }


def build_invocation(child: str, args: dict, shots: int | None, return_bindings: dict) -> dict:
    return {
        "protocol_version": BRIDGE_PROTOCOL_VERSION,
        "child": child,
        "args": dict(args),
        "shots": shots,
        "return_bindings": dict(return_bindings),
    }


def make_result(final_state: str, returns: dict, error: dict | None = None) -> dict:
    envelope = {
        "protocol_version": BRIDGE_PROTOCOL_VERSION,
        "final_state": final_state,
        "returns": dict(returns),
    }
    if error is not None:
        envelope["error"] = error
    return envelope


def _check_version(envelope: dict, kind: str) -> None:
    version = envelope.get("protocol_version")
    if version != BRIDGE_PROTOCOL_VERSION:
        raise BridgeError(
            f"unsupported bridge {kind} protocol_version {version!r} "
            f"(this tool speaks {BRIDGE_PROTOCOL_VERSION!r})"
        )


def _load(data: Any, kind: str) -> dict:
    if isinstance(data, (str, bytes)):
        try:
            data = json.loads(data)
        except (ValueError, TypeError) as exc:
            raise BridgeError(f"{kind} envelope is not valid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise BridgeError(f"{kind} envelope must be a JSON object")
    _check_version(data, kind)
    return data


def parse_result(data: Any) -> dict:
    env = _load(data, "result")
    return {
        "final_state": env.get("final_state", ""),
        "returns": env.get("returns") or {},
        "error": env.get("error"),
    }


def parse_invocation(data: Any) -> dict:
    env = _load(data, "invocation")
    if "child" not in env:
        raise BridgeError("invocation envelope is missing 'child'")
    return {
        "child": env["child"],
        "args": env.get("args") or {},
        "shots": env.get("shots"),
        "return_bindings": env.get("return_bindings") or {},
    }


def dispatch_foreign(runner_argv: list[str], invocation: dict, timeout: float = _DEFAULT_TIMEOUT_S) -> dict:
    """Run a foreign child via ``runner_argv``: invocation envelope on stdin,
    result envelope on stdout. Raises ``BridgeError`` on any transport failure."""
    payload = json.dumps(invocation)
    try:
        proc = subprocess.run(
            runner_argv, input=payload, capture_output=True, text=True, timeout=timeout
        )
    except FileNotFoundError as exc:
        raise BridgeError(f"foreign runner not found: {runner_argv[0]!r}") from exc
    except subprocess.TimeoutExpired as exc:
        raise BridgeError(f"foreign runner timed out after {timeout}s") from exc

    try:
        return parse_result(proc.stdout)
    except BridgeError as exc:
        stderr = proc.stderr.strip()[:300]
        if proc.returncode != 0:
            raise BridgeError(
                f"foreign runner exited {proc.returncode}"
                + (f": {stderr}" if stderr else "")
            ) from exc
        # Exit 0 but unusable output — surface stderr to aid debugging.
        if stderr:
            raise BridgeError(f"{exc} (runner stderr: {stderr})") from exc
        raise
