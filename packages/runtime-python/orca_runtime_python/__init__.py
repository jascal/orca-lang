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

from .machine import OrcaMachine

from .parser import parse_orca_md, parse_orca_auto

__version__ = "0.1.0"

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
    # Parser
    "parse_orca_md",
    "parse_orca_auto",
]
