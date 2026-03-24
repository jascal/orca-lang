"""Orca language parser - Parses simple state machine definitions."""

import re
from typing import List, Tuple, Optional
from orca.types import (
    MachineDefinition, State, Transition, Context,
    StateType, Transition as TransitionType
)


def parse_orca(source: str) -> MachineDefinition:
    """Parse Orca source text into a MachineDefinition.

    Simple syntax:
        machine OrderProcessor

        context { order_id: "" status: "pending" }

        state pending [initial]
          on ORDER_PLACED -> validating

        state validating
          on VALIDATED -> processing
          on REJECTED -> rejected

        transitions {
          pending + ORDER_PLACED -> validating
          validating + VALIDATED -> processing
        }
    """
    lines = source.strip().split("\n")
    lines = [l.strip() for l in lines if l.strip() and not l.strip().startswith("#")]

    name = "UnnamedMachine"
    context_data = {}
    states: List[State] = []
    transitions: List[TransitionType] = []
    initial_state = ""

    i = 0
    while i < len(lines):
        line = lines[i]

        # Machine name
        if line.startswith("machine "):
            name = line.split(" ", 1)[1].strip()

        # Context definition
        elif line.startswith("context"):
            # Parse context block: context { key: value ... }
            context_match = re.match(r"context\s*\{(.+)\}", line)
            if context_match:
                ctx_str = context_match.group(1)
                for part in ctx_str.split(","):
                    part = part.strip()
                    if ":" in part:
                        k, v = part.split(":", 1)
                        context_data[k.strip()] = _parse_value(v.strip())

        # State definition
        elif line.startswith("state "):
            state_name, state_type, desc = _parse_state_line(line)
            state = State(
                name=state_name,
                state_type=state_type,
                description=desc
            )

            # Look for transition lines after this state
            i += 1
            while i < len(lines) and not lines[i].startswith("state ") and not lines[i].startswith("transitions"):
                trans_line = lines[i]
                if trans_line.startswith("on "):
                    src, evt, tgt, guard, action = _parse_transition(trans_line)
                    # For "on" syntax, src is empty, so use state_name
                    state.transitions.append(TransitionType(
                        source=state_name, event=evt, target=tgt,
                        guard=guard, action=action
                    ))
                i += 1
            i -= 1  # Back up one since we incremented extra

            states.append(state)
            if state_type == StateType.INITIAL:
                initial_state = state_name

        # Transitions block
        elif line.startswith("transitions"):
            i += 1
            while i < len(lines) and not lines[i].startswith("state ") and lines[i].strip() != "}":
                trans_line = lines[i].strip()
                if trans_line and not trans_line.startswith("transitions"):
                    src, evt, tgt, guard, action = _parse_transition(trans_line)
                    transitions.append(TransitionType(
                        source=src, event=evt, target=tgt,
                        guard=guard, action=action
                    ))
                i += 1

        i += 1

    # If no initial state found, use first state
    if not initial_state and states:
        initial_state = states[0].name

    return MachineDefinition(
        name=name,
        context=Context(data=context_data),
        states=states,
        transitions=transitions,
        initial_state=initial_state
    )


def _parse_state_line(line: str) -> Tuple[str, StateType, str]:
    """Parse a state definition line."""
    # Format: state name [type] "description"
    match = re.match(r'state\s+(\w+)(?:\s+\[(\w+)\])?(?:\s+["\'](.+?)["\'])?', line)
    if match:
        name = match.group(1)
        type_str = match.group(2) or "normal"
        desc = match.group(3) or ""

        if type_str == "initial":
            state_type = StateType.INITIAL
        elif type_str == "final":
            state_type = StateType.FINAL
        else:
            state_type = StateType.NORMAL

        return name, state_type, desc

    return line.split()[1], StateType.NORMAL, ""


def _parse_transition(line: str) -> Tuple[str, str, str, Optional[str], Optional[str]]:
    """Parse a transition line."""
    # Format: source + EVENT -> target : action
    # or: source + EVENT [guard] -> target : action
    # or: on EVENT -> target : action (for inline state transitions)
    match = re.match(r"(\w+)\s*\+\s*(\w+)(?:\s*\[([^\]]+)\])?\s*->\s*(\w+)(?:\s*:\s*(\w+))?", line)
    if match:
        return (
            match.group(1),
            match.group(2),
            match.group(4),
            match.group(3),
            match.group(5)
        )
    # Handle "on EVENT -> target" syntax (inline state transitions)
    on_match = re.match(r"on\s+(\w+)\s*(?:\[([^\]]+)\])?\s*->\s*(\w+)(?:\s*:\s*(\w+))?", line)
    if on_match:
        return (
            "",  # source will be filled in by caller
            on_match.group(1),
            on_match.group(3),
            on_match.group(2),
            on_match.group(4)
        )
    return "", "", "", None, None


def _parse_value(s: str) -> str:
    """Parse a context value."""
    s = s.strip().strip(",")
    if s.startswith('"') and s.endswith('"'):
        return s[1:-1]
    if s.startswith("'") and s.endswith("'"):
        return s[1:-1]
    if s == "true":
        return True
    if s == "false":
        return False
    if s.isdigit():
        return int(s)
    return s
