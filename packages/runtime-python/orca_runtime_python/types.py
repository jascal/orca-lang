"""
Core type definitions for Orca runtime.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, TypedDict


# Context type - represents the machine's state
Context = dict[str, Any]


@dataclass
class StateDef:
    """State definition in an Orca machine."""
    name: str
    is_initial: bool = False
    is_final: bool = False
    on_entry: str | None = None
    on_exit: str | None = None
    description: str | None = None
    contains: list[StateDef] = field(default_factory=list)
    parent: str | None = None
    timeout: dict[str, str] | None = None  # {duration, target}
    ignored_events: list[str] = field(default_factory=list)


@dataclass
class Transition:
    """Transition between states."""
    source: str
    event: str
    target: str
    guard: str | None = None
    action: str | None = None


@dataclass
class GuardDef:
    """Guard condition definition."""
    name: str
    expression: GuardExpression


@dataclass
class ActionSignature:
    """Action function signature."""
    name: str
    parameters: list[str]
    return_type: str
    has_effect: bool = False
    effect_type: str | None = None


@dataclass
class MachineDef:
    """Complete Orca machine definition."""
    name: str
    context: dict[str, Any]
    events: list[str]
    states: list[StateDef]
    transitions: list[Transition]
    guards: dict[str, GuardExpression] = field(default_factory=dict)
    actions: list[ActionSignature] = field(default_factory=list)


class GuardExpression:
    """Union type for guard expressions."""
    pass


@dataclass
class GuardTrue(GuardExpression):
    """True literal guard."""
    pass


@dataclass
class GuardFalse(GuardExpression):
    """False literal guard."""
    pass


@dataclass
class GuardCompare(GuardExpression):
    """Comparison guard: left op right"""
    op: str  # eq, ne, lt, gt, le, ge
    left: VariableRef
    right: ValueRef


@dataclass
class GuardAnd(GuardExpression):
    """And guard: left and right"""
    left: GuardExpression
    right: GuardExpression


@dataclass
class GuardOr(GuardExpression):
    """Or guard: left or right"""
    left: GuardExpression
    right: GuardExpression


@dataclass
class GuardNot(GuardExpression):
    """Not guard: not expr"""
    expr: GuardExpression


@dataclass
class GuardNullcheck(GuardExpression):
    """Null check guard: expr is (not) null"""
    expr: VariableRef
    is_null: bool


@dataclass
class VariableRef:
    """Variable path reference."""
    path: list[str]


@dataclass
class ValueRef:
    """Value literal reference."""
    type: str  # string, number, boolean, null
    value: str | int | float | bool | None


@dataclass
class Effect:
    """Represents an effect (async operation) to be executed."""
    type: str
    payload: dict[str, Any] = field(default_factory=dict)


@dataclass
class EffectResult:
    """Result of an effect execution."""
    status: EffectStatus
    data: Any = None
    error: str | None = None


class EffectStatus:
    """Effect execution status."""
    SUCCESS = "success"
    FAILURE = "failure"


class StateValue:
    """
    Represents the current state of a machine.
    Supports both simple (string) and compound (nested) states.
    """

    def __init__(self, value: str | dict[str, Any]):
        self.value = value

    def __str__(self) -> str:
        if isinstance(self.value, str):
            return self.value
        return self._format_compound()

    def __repr__(self) -> str:
        return f"StateValue({self.value!r})"

    def __eq__(self, other: object) -> bool:
        if isinstance(other, StateValue):
            return self.value == other.value
        if isinstance(other, str):
            return self.value == other
        if isinstance(other, dict):
            return self.value == other
        return False

    def _format_compound(self) -> str:
        """Format compound state as dot-notation string."""
        if isinstance(self.value, str):
            return self.value

        def format_recursive(d: dict[str, Any], prefix: str = "") -> str:
            parts = []
            for key, val in d.items():
                if isinstance(val, dict) and val:
                    # Non-empty nested dict, recurse deeper
                    parts.append(format_recursive(val, prefix + key + "."))
                else:
                    # Empty dict or non-dict - key is a leaf state
                    parts.append(prefix + key)
            return ", ".join(parts) if parts else str(d)

        return format_recursive(self.value)

    def is_compound(self) -> bool:
        """Check if this is a compound (nested) state."""
        return isinstance(self.value, dict)

    def leaf(self) -> str:
        """Get the leaf state name from compound state."""
        if isinstance(self.value, str):
            return self.value
        if isinstance(self.value, dict):
            # Recursively find the deepest state
            for key, val in self.value.items():
                if isinstance(val, dict) and val:
                    # Non-empty nested dict, recurse
                    result = StateValue(val).leaf()
                    if result:
                        return result
                else:
                    # Empty dict or non-dict value - 'key' is the leaf
                    return key
        return str(self.value)

    def parent_names(self) -> list[str]:
        """Get all parent state names (for nested states)."""
        if isinstance(self.value, str):
            return []
        if isinstance(self.value, dict):
            return list(self.value.keys())
        return []
