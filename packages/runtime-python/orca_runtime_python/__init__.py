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
    ReturnDef,
    InvokeDef,
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

from .bridge import (
    BRIDGE_PROTOCOL_VERSION,
    BridgeError,
    descriptor_for,
    build_invocation,
    make_result,
    parse_result,
    parse_invocation,
    dispatch_foreign,
)

from .persistence import PersistenceAdapter, AsyncPersistenceAdapter, FilePersistence

from .logging import LogSink, FileSink, ConsoleSink, MultiSink

__version__ = "0.1.30"

__all__ = [
    # Types
    "StateDef",
    "Transition",
    "GuardDef",
    "ActionSignature",
    "EffectDef",
    "ReturnDef",
    "InvokeDef",
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
    # Bridge (cross-tool composition)
    "BRIDGE_PROTOCOL_VERSION",
    "BridgeError",
    "descriptor_for",
    "build_invocation",
    "make_result",
    "parse_result",
    "parse_invocation",
    "dispatch_foreign",
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
