"""Smoke tests for Orca markdown parser in runtime-python."""

import os
from pathlib import Path

from orca_runtime_python.parser import parse_orca_md, parse_orca_auto

EXAMPLES_DIR = Path(__file__).parent.parent.parent / "orca-lang" / "examples"


def test_parse_payment_processor_md():
    """Parse payment-processor.orca.md and verify structure."""
    source = (EXAMPLES_DIR / "payment-processor.orca.md").read_text()
    machine = parse_orca_md(source)

    assert machine.name == "PaymentProcessor"
    assert len(machine.states) == 7
    assert len(machine.events) == 8
    assert len(machine.transitions) == 11
    assert len(machine.guards) == 2
    assert len(machine.actions) == 14
    assert len(machine.context) == 6

    # Initial and final states
    initial = [s for s in machine.states if s.is_initial]
    assert len(initial) == 1
    assert initial[0].name == "idle"
    finals = [s for s in machine.states if s.is_final]
    assert len(finals) == 2

    # on_entry
    validating = next(s for s in machine.states if s.name == "validating")
    assert validating.on_entry == "validate_payment_details"

    # Guard expression
    can_retry = machine.guards["can_retry"]
    assert can_retry.op == "lt"

    # Context default
    assert machine.context["retry_count"] == 0

    # Transition guard
    guarded = [t for t in machine.transitions if t.guard == "can_retry"]
    assert len(guarded) == 1
    assert guarded[0].source == "declined"


def test_auto_detect_md():
    """Auto-detect markdown format by filename."""
    source = (EXAMPLES_DIR / "payment-processor.orca.md").read_text()
    machine = parse_orca_auto(source, "payment.orca.md")
    assert machine.name == "PaymentProcessor"


def test_auto_detect_content_sniff_md():
    """Auto-detect markdown by content sniffing."""
    source = (EXAMPLES_DIR / "payment-processor.orca.md").read_text()
    machine = parse_orca_auto(source)
    assert machine.name == "PaymentProcessor"


def test_parse_parallel_md():
    """Parse parallel-order.orca.md and verify parallel regions."""
    source = (EXAMPLES_DIR / "parallel-order.orca.md").read_text()
    machine = parse_orca_md(source)

    assert machine.name == "ParallelOrderProcessor"
    processing = next(s for s in machine.states if s.name == "processing")
    assert processing.parallel is not None
    assert len(processing.parallel.regions) == 2
    assert processing.on_done == "completed"


def test_parse_hierarchical_md():
    """Parse hierarchical-game.orca.md and verify hierarchy."""
    source = (EXAMPLES_DIR / "hierarchical-game.orca.md").read_text()
    machine = parse_orca_md(source)

    assert machine.name == "HierarchicalGame"
    exploration = next(s for s in machine.states if s.name == "exploration")
    assert len(exploration.contains) == 2
    assert exploration.contains[0].parent == "exploration"


def test_parse_simple_toggle_md():
    """Parse simple-toggle.orca.md and verify basic structure."""
    source = (EXAMPLES_DIR / "simple-toggle.orca.md").read_text()
    machine = parse_orca_md(source)

    assert machine.name == "SimpleToggle"
    assert len(machine.states) >= 2
    assert len(machine.events) >= 1
    assert machine.context["count"] == 0
