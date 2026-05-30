"""Tests for the cross-tool bridge — orca's Python side.

Mirrors q-orca's bridge-protocol contract (version 1.0). The runtime test drives
an orca classical orchestrator invoking a foreign quantum child over the bridge,
using a mock foreign runner (so the suite has no q-orca dependency).
"""

import json
import sys

import pytest

from orca_runtime_python.bridge import (
    BRIDGE_PROTOCOL_VERSION,
    BridgeError,
    build_invocation,
    descriptor_for,
    dispatch_foreign,
    make_result,
    parse_invocation,
    parse_result,
)
from orca_runtime_python.machine import OrcaMachine
from orca_runtime_python.parser import parse_orca_md

# A mock foreign runner: reads the invocation envelope from stdin, echoes a
# fixed result envelope (a 73%-expectation forward pass) on stdout.
_MOCK_RESULT = {
    "protocol_version": "1.0",
    "final_state": "measured",
    "returns": {"prob_bits_0": 0.73, "hist_bits_0": {"0": 270, "1": 730}},
}
_MOCK_RUNNER = [
    sys.executable, "-c",
    "import sys,json; json.load(sys.stdin); "
    f"print(json.dumps({_MOCK_RESULT!r}))",
]
_FAILING_RUNNER = [sys.executable, "-c", "import sys; sys.stderr.write('boom'); sys.exit(1)"]


# ---------------------------------------------------------------------------
# Parser: ## returns + invoke returns/shots
# ---------------------------------------------------------------------------

class TestReturnsParsing:
    def test_returns_section(self):
        src = (
            "# machine Counter\n## context\n| Field | Type |\n| n | int |\n"
            "## returns\n| Name | Type | Statistics |\n| converged | bool | |\n"
            "## state a [initial]\n## state b [final]\n"
            "## transitions\n| Source | Event | Target |\n| a | go | b |\n"
        )
        m = parse_orca_md(src)
        assert len(m.returns) == 1
        assert m.returns[0].name == "converged" and m.returns[0].type == "bool"

    def test_invoke_inline_shots_and_returns(self):
        src = (
            "# machine Trainer\n## context\n| Field | Type |\n| theta | float |\n"
            "## state step [initial]\n"
            "- invoke: QForward input: { theta: ctx.theta } shots: 1024 returns: { prob: prob_bits_0 }\n"
            "- on_done: STEPPED\n"
            "## state stepped [final]\n"
            "## transitions\n| Source | Event | Target |\n| step | STEPPED | stepped |\n"
        )
        inv = parse_orca_md(src).states[0].invoke
        assert inv.machine == "QForward" and inv.shots == 1024
        assert inv.returns == {"prob": "prob_bits_0"}
        assert inv.input == {"theta": "ctx.theta"} and inv.on_done == "STEPPED"

    def test_invoke_multiline_returns_bullet(self):
        src = (
            "# machine Trainer\n## context\n| Field | Type |\n| theta | float |\n"
            "## state step [initial]\n"
            "- invoke: QForward input: { theta: ctx.theta } shots: 1024\n"
            "- returns: { prob: prob_bits_0, hist: hist_bits_0 }\n"
            "- on_done: STEPPED\n"
            "## state stepped [final]\n"
            "## transitions\n| Source | Event | Target |\n| step | STEPPED | stepped |\n"
        )
        inv = parse_orca_md(src).states[0].invoke
        assert inv.returns == {"prob": "prob_bits_0", "hist": "hist_bits_0"}
        assert inv.shots == 1024


# ---------------------------------------------------------------------------
# Protocol envelopes (conformance with q-orca's 1.0 contract)
# ---------------------------------------------------------------------------

class TestProtocol:
    def test_version_constant(self):
        assert BRIDGE_PROTOCOL_VERSION == "1.0"

    def test_descriptor_classical(self):
        m = parse_orca_md(
            "# machine Counter\n## context\n| Field | Type |\n| n | int |\n"
            "## returns\n| Name | Type | Statistics |\n| converged | bool | |\n"
            "## state a [initial]\n## state b [final]\n"
            "## transitions\n| Source | Event | Target |\n| a | go | b |\n"
        )
        d = descriptor_for(m)
        assert d["measurement_bearing"] is False
        assert d["protocol_version"] == "1.0"
        assert d["returns"][0]["name"] == "converged"

    def test_envelope_round_trip(self):
        inv = build_invocation("QForward", {"theta": 0.5}, 1024, {"prob": "prob_bits_0"})
        assert parse_invocation(json.dumps(inv))["child"] == "QForward"
        res = make_result("measured", {"prob_bits_0": 0.73})
        assert parse_result(json.dumps(res))["returns"]["prob_bits_0"] == 0.73

    def test_version_mismatch_raises(self):
        with pytest.raises(BridgeError):
            parse_result({"protocol_version": "0.0", "final_state": "x", "returns": {}})

    def test_non_json_raises(self):
        with pytest.raises(BridgeError):
            parse_result("not json {")


# ---------------------------------------------------------------------------
# Dispatch (outbound) over a real subprocess
# ---------------------------------------------------------------------------

class TestDispatch:
    def test_dispatch_foreign_round_trip(self):
        inv = build_invocation("QForward", {"theta": 0.5}, 1024, {"prob": "prob_bits_0"})
        result = dispatch_foreign(_MOCK_RUNNER, inv)
        assert result["returns"]["prob_bits_0"] == 0.73
        assert result["final_state"] == "measured"

    def test_bridge_error_on_unlaunchable_runner(self):
        with pytest.raises(BridgeError):
            dispatch_foreign(["orca-no-such-binary-xyz"], build_invocation("X", {}, None, {}))

    def test_bridge_error_on_failing_runner(self):
        with pytest.raises(BridgeError):
            dispatch_foreign(_FAILING_RUNNER, build_invocation("X", {}, None, {}))


# ---------------------------------------------------------------------------
# Runtime: an orca orchestrator invokes a foreign quantum child
# ---------------------------------------------------------------------------

_TRAINER = """# machine Trainer
## context
| Field | Type | Default |
| theta | float | 0.5 |
| prob | float | 0.0 |
## state step [initial]
- invoke: QForward input: { theta: ctx.theta } shots: 512 returns: { prob: prob_bits_0 }
- on_done: STEPPED
## state stepped [final]
## transitions
| Source | Event | Target |
| step | STEPPED | stepped |
"""


async def test_orca_parent_invokes_foreign_quantum_child():
    machine = OrcaMachine(definition=parse_orca_md(_TRAINER))
    machine.register_foreign_runner("QForward", _MOCK_RUNNER)
    await machine.start()
    # The bridge bound the child's prob_bits_0 aggregate into the parent context,
    # and on_done drove the transition to the final state.
    assert machine.context["prob"] == 0.73
    assert machine.state.leaf() == "stepped"
    await machine.stop()
