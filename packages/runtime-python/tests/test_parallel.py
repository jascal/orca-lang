"""Tests for parallel region support in the Python runtime."""

import asyncio
from orca_runtime_python.parser import parse_orca
from orca_runtime_python.machine import OrcaMachine
from orca_runtime_python.bus import EventBus


PARALLEL_MACHINE_SRC = """machine order_processor

events {
  START
  PAYMENT_OK
  PAYMENT_FAIL
  NOTIFIED
  CANCEL
}

state idle [initial] {
}

state processing {
  on_done: -> completed
  parallel {
    region payment_flow {
      state charging [initial] {
      }
      state charged [final] {
      }
    }
    region notification_flow {
      state sending [initial] {
      }
      state sent [final] {
      }
    }
  }
}

state completed [final] {
}

state cancelled {
}

transitions {
  idle + START -> processing
  charging + PAYMENT_OK -> charged
  sending + NOTIFIED -> sent
  processing + CANCEL -> cancelled
}
"""


PARALLEL_SYNC_ANY_SRC = """machine fast_processor

events {
  START
  DONE_A
  DONE_B
}

state idle [initial] {
}

state processing {
  on_done: -> completed
  parallel [sync: any_final] {
    region flow_a {
      state running_a [initial] {
      }
      state done_a [final] {
      }
    }
    region flow_b {
      state running_b [initial] {
      }
      state done_b [final] {
      }
    }
  }
}

state completed [final] {
}

transitions {
  idle + START -> processing
  running_a + DONE_A -> done_a
  running_b + DONE_B -> done_b
}
"""


# ---- Parser tests ----

def test_parse_parallel_regions():
    """Parser should create parallel regions from parallel block."""
    machine = parse_orca(PARALLEL_MACHINE_SRC)
    processing = next(s for s in machine.states if s.name == "processing")
    assert processing.parallel is not None
    assert len(processing.parallel.regions) == 2


def test_parse_parallel_region_names():
    """Parser should extract region names."""
    machine = parse_orca(PARALLEL_MACHINE_SRC)
    processing = next(s for s in machine.states if s.name == "processing")
    region_names = [r.name for r in processing.parallel.regions]
    assert "payment_flow" in region_names
    assert "notification_flow" in region_names


def test_parse_parallel_region_states():
    """Parser should extract states within each region."""
    machine = parse_orca(PARALLEL_MACHINE_SRC)
    processing = next(s for s in machine.states if s.name == "processing")
    payment_region = next(r for r in processing.parallel.regions if r.name == "payment_flow")
    state_names = [s.name for s in payment_region.states]
    assert "charging" in state_names
    assert "charged" in state_names


def test_parse_on_done():
    """Parser should extract on_done target."""
    machine = parse_orca(PARALLEL_MACHINE_SRC)
    processing = next(s for s in machine.states if s.name == "processing")
    assert processing.on_done == "completed"


def test_parse_sync_strategy():
    """Parser should extract sync strategy annotation."""
    machine = parse_orca(PARALLEL_SYNC_ANY_SRC)
    processing = next(s for s in machine.states if s.name == "processing")
    assert processing.parallel is not None
    assert processing.parallel.sync == "any-final"


def test_parse_initial_final_in_regions():
    """Parser should mark initial/final states within regions."""
    machine = parse_orca(PARALLEL_MACHINE_SRC)
    processing = next(s for s in machine.states if s.name == "processing")
    payment_region = next(r for r in processing.parallel.regions if r.name == "payment_flow")
    charging = next(s for s in payment_region.states if s.name == "charging")
    charged = next(s for s in payment_region.states if s.name == "charged")
    assert charging.is_initial is True
    assert charged.is_final is True


# ---- Machine tests ----

async def _test_parallel_state_entry():
    machine_def = parse_orca(PARALLEL_MACHINE_SRC)
    bus = EventBus()
    machine = OrcaMachine(machine_def, event_bus=bus)
    await machine.start()

    result = await machine.send("START")
    assert result.taken is True

    # State should be a compound value with both regions
    assert machine.state.is_compound()
    leaves = machine.state.leaves()
    assert "charging" in leaves
    assert "sending" in leaves

def test_parallel_state_entry():
    asyncio.run(_test_parallel_state_entry())


async def _test_parallel_region_transition():
    machine_def = parse_orca(PARALLEL_MACHINE_SRC)
    bus = EventBus()
    machine = OrcaMachine(machine_def, event_bus=bus)
    await machine.start()

    await machine.send("START")
    result = await machine.send("PAYMENT_OK")
    assert result.taken is True

    leaves = machine.state.leaves()
    assert "charged" in leaves
    assert "sending" in leaves

def test_parallel_region_transition():
    asyncio.run(_test_parallel_region_transition())


async def _test_parallel_sync_all_final():
    machine_def = parse_orca(PARALLEL_MACHINE_SRC)
    bus = EventBus()
    machine = OrcaMachine(machine_def, event_bus=bus)
    await machine.start()

    await machine.send("START")
    await machine.send("PAYMENT_OK")
    await machine.send("NOTIFIED")

    # Both regions are final -> should auto-transition to completed
    assert str(machine.state) == "completed"

def test_parallel_sync_all_final():
    asyncio.run(_test_parallel_sync_all_final())


async def _test_parallel_sync_all_final_not_triggered_early():
    machine_def = parse_orca(PARALLEL_MACHINE_SRC)
    bus = EventBus()
    machine = OrcaMachine(machine_def, event_bus=bus)
    await machine.start()

    await machine.send("START")
    await machine.send("PAYMENT_OK")

    # Only payment region is final, not notification
    assert machine.state.is_compound()
    leaves = machine.state.leaves()
    assert "charged" in leaves
    assert "sending" in leaves

def test_parallel_sync_all_final_not_triggered_early():
    asyncio.run(_test_parallel_sync_all_final_not_triggered_early())


async def _test_parallel_sync_any_final():
    machine_def = parse_orca(PARALLEL_SYNC_ANY_SRC)
    bus = EventBus()
    machine = OrcaMachine(machine_def, event_bus=bus)
    await machine.start()

    await machine.send("START")
    await machine.send("DONE_A")

    # Only flow_a is final, but any-final should trigger
    assert str(machine.state) == "completed"

def test_parallel_sync_any_final():
    asyncio.run(_test_parallel_sync_any_final())


async def _test_parallel_parent_transition():
    machine_def = parse_orca(PARALLEL_MACHINE_SRC)
    bus = EventBus()
    machine = OrcaMachine(machine_def, event_bus=bus)
    await machine.start()

    await machine.send("START")
    result = await machine.send("CANCEL")
    assert result.taken is True
    assert str(machine.state) == "cancelled"

def test_parallel_parent_transition():
    asyncio.run(_test_parallel_parent_transition())


async def _test_parallel_transition_callback():
    transitions_log = []

    async def on_transition(old_state, new_state):
        transitions_log.append((str(old_state), str(new_state)))

    machine_def = parse_orca(PARALLEL_MACHINE_SRC)
    bus = EventBus()
    machine = OrcaMachine(machine_def, event_bus=bus, on_transition=on_transition)
    await machine.start()

    await machine.send("START")
    assert len(transitions_log) == 1
    assert transitions_log[0][0] == "idle"

def test_parallel_transition_callback():
    asyncio.run(_test_parallel_transition_callback())
