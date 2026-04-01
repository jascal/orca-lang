"""Orca state machine module - Event-driven state machine framework.

This module provides Orca state machine functionality using local implementations.
For orca-runtime-python integration, see the orca_runtime_python package.
"""

# Local implementations
from orca.machine import OrcaMachine, State, Transition, Context
from orca.types import Event
from orca.parser import parse_orca, parse_orca_multi

__all__ = ["OrcaMachine", "State", "Transition", "Event", "Context", "parse_orca", "parse_orca_multi"]
