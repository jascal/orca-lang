"""
Orca Runtime Python

A first-class Python async runtime for Orca state machines.
"""

from .types import (
    StateDef,
    Transition,
    GuardDef,
    ActionSignature,
    EffectDef,
    MachineDef,
    StateValue,
    Context,
    Effect,
    EffectResult,
    EffectStatus,
)

from .bus import (
    EventBus,
    Event,
    EventType,
    get_event_bus,
)

from .machine import OrcaMachine, MachineNotActiveError, TransitionResult

from .parser import parse_orca_md, parse_orca_auto

from .persistence import PersistenceAdapter, AsyncPersistenceAdapter, FilePersistence

from .logging import LogSink, FileSink, ConsoleSink, MultiSink

__version__ = "0.1.26"

__all__ = [
    # Types
    "StateDef",
    "Transition",
    "GuardDef",
    "ActionSignature",
    "EffectDef",
    "MachineDef",
    "StateValue",
    "Context",
    "Effect",
    "EffectResult",
    "EffectStatus",
    # Bus
    "EventBus",
    "Event",
    "EventType",
    "get_event_bus",
    # Machine
    "OrcaMachine",
    "MachineNotActiveError",
    "TransitionResult",
    # Parser
    "parse_orca_md",
    "parse_orca_auto",
    # Persistence
    "PersistenceAdapter",
    "AsyncPersistenceAdapter",
    "FilePersistence",
    # Logging
    "LogSink",
    "FileSink",
    "ConsoleSink",
    "MultiSink",
]
