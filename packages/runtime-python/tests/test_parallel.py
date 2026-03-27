"""Tests for parallel region support in the Python runtime."""

import asyncio
from orca_runtime_python.parser import parse_orca_md
from orca_runtime_python.machine import OrcaMachine
from orca_runtime_python.bus import EventBus


PARALLEL_MACHINE_MD = """# machine order_processor

## events

- START
- PAYMENT_OK
- PAYMENT_FAIL
- NOTIFIED
- CANCEL

## state idle [initial]
> Idle state

## state processing [parallel]
> Processing state
- on_done: -> completed

### region payment_flow

#### state charging [initial]
> Charging state

#### state charged [final]
> Charged state


### region notification_flow

#### state sending [initial]
> Sending state

#### state sent [final]
> Sent state


## state completed [final]
> Completed state

## state cancelled
> Cancelled state

## transitions

| Source | Event | Target |
|--------|-------|--------|
| idle   | START | processing |
| charging | PAYMENT_OK | charged |
| sending | NOTIFIED | sent |
| processing | CANCEL | cancelled |
"""


PARALLEL_SYNC_ANY_MD = """# machine fast_processor

## events

- START
- DONE_A
- DONE_B

## state idle [initial]
> Idle state

## state processing [parallel]
> Processing state
- on_done: -> completed

### region flow_a

#### state running_a [initial]
> Running A state

#### state done_a [final]
> Done A state


### region flow_b

#### state running_b [initial]
> Running B state

#### state done_b [final]
> Done B state


## state completed [final]
> Completed state

## transitions

| Source | Event | Target |
|--------|-------|--------|
| idle   | START | processing |
| running_a | DONE_A | done_a |
| running_b | DONE_B | done_b |
"""


# ---- Parser tests ----

def test_parse_parallel_regions():
    """Parser should create parallel regions from parallel block."""
    machine = parse_orca_md(PARALLEL_MACHINE_MD)
    processing = next(s for s in machine.states if s.name == "processing")
    assert processing.parallel is not None
    assert len(processing.parallel.regions) == 2


def test_parse_parallel_region_names():
    """Parser should extract region names."""
    machine = parse_orca_md(PARALLEL_MACHINE_MD)
    processing = next(s for s in machine.states if s.name == "processing")
    region_names = [r.name for r in processing.parallel.regions]
    assert "payment_flow" in region_names
    assert "notification_flow" in region_names


def test_parse_parallel_region_states():
    """Parser should extract states within each region."""
    machine = parse_orca_md(PARALLEL_MACHINE_MD)
    processing = next(s for s in machine.states if s.name == "processing")
    payment_region = next(r for r in processing.parallel.regions if r.name == "payment_flow")
    state_names = [s.name for s in payment_region.states]
    assert "charging" in state_names
    assert "charged" in state_names


def test_parse_on_done():
    """Parser should extract on_done target."""
    machine = parse_orca_md(PARALLEL_MACHINE_MD)
    processing = next(s for s in machine.states if s.name == "processing")
    assert processing.on_done == "completed"


def test_parse_initial_final_in_regions():
    """Parser should mark initial/final states within regions."""
    machine = parse_orca_md(PARALLEL_MACHINE_MD)
    processing = next(s for s in machine.states if s.name == "processing")
    payment_region = next(r for r in processing.parallel.regions if r.name == "payment_flow")
    charging = next(s for s in payment_region.states if s.name == "charging")
    charged = next(s for s in payment_region.states if s.name == "charged")
    assert charging.is_initial is True
    assert charged.is_final is True


# ---- Machine tests ----

async def _test_parallel_state_entry():
    machine_def = parse_orca_md(PARALLEL_MACHINE_MD)
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
    machine_def = parse_orca_md(PARALLEL_MACHINE_MD)
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
    machine_def = parse_orca_md(PARALLEL_MACHINE_MD)
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
    machine_def = parse_orca_md(PARALLEL_MACHINE_MD)
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


async def _test_parallel_parent_transition():
    machine_def = parse_orca_md(PARALLEL_MACHINE_MD)
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

    machine_def = parse_orca_md(PARALLEL_MACHINE_MD)
    bus = EventBus()
    machine = OrcaMachine(machine_def, event_bus=bus, on_transition=on_transition)
    await machine.start()

    await machine.send("START")
    assert len(transitions_log) == 1
    assert transitions_log[0][0] == "idle"

def test_parallel_transition_callback():
    asyncio.run(_test_parallel_transition_callback())
