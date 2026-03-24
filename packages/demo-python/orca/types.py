"""Orca state machine types."""

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Union
from enum import Enum


class StateType(Enum):
    """State type classification."""
    NORMAL = "normal"
    INITIAL = "initial"
    FINAL = "final"
    ERROR = "error"


@dataclass
class Context:
    """Machine context for storing state."""
    data: Dict[str, Any] = field(default_factory=dict)

    def get(self, key: str, default: Any = None) -> Any:
        return self.data.get(key, default)

    def set(self, key: str, value: Any) -> None:
        self.data[key] = value

    def update(self, **kwargs) -> None:
        self.data.update(kwargs)


@dataclass
class Transition:
    """State transition definition."""
    source: str
    event: str
    target: str
    guard: Optional[str] = None
    action: Optional[str] = None


@dataclass
class State:
    """State definition."""
    name: str
    state_type: StateType = StateType.NORMAL
    description: str = ""
    entry_action: Optional[str] = None
    exit_action: Optional[str] = None
    transitions: List[Transition] = field(default_factory=list)


@dataclass
class Event:
    """Event structure."""
    type: str
    data: Dict[str, Any] = field(default_factory=dict)


@dataclass
class MachineDefinition:
    """State machine definition."""
    name: str
    context: Context
    states: List[State]
    transitions: List[Transition]
    initial_state: str
