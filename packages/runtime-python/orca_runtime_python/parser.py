"""
Orca DSL parser.

Parses Orca machine definition text into MachineDef objects.
Supports hierarchical (nested) states.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from .types import (
    MachineDef,
    StateDef,
    Transition,
    GuardDef,
    ActionSignature,
    GuardExpression,
    GuardTrue,
    GuardFalse,
)


class ParseError(Exception):
    """Raised when parsing fails."""
    pass


def parse_orca(source: str) -> MachineDef:
    """
    Parse Orca DSL text into a MachineDef.

    Supports hierarchical states with nested state blocks.
    """
    lines = source.strip().split("\n")
    pos = 0
    machine_name = "unknown"

    # Find machine name
    while pos < len(lines):
        line = lines[pos].strip()
        if line.startswith("machine "):
            parts = line.split()
            if len(parts) >= 2:
                machine_name = parts[1]
            pos += 1
            break
        if line:
            pos += 1
        else:
            pos += 1

    # Parse remaining sections
    context: dict[str, Any] = {}
    events: list[str] = []
    states: list[StateDef] = []
    transitions: list[Transition] = []
    guards: dict[str, GuardExpression] = {}
    actions: list[ActionSignature] = []

    while pos < len(lines):
        line = lines[pos].strip()

        if not line:
            pos += 1
            continue

        if line.startswith("context"):
            context_str, pos = _collect_block(lines, pos)
            context = _parse_context(context_str)
        elif line.startswith("events"):
            events_str, pos = _collect_block(lines, pos)
            events = _parse_events(events_str)
        elif line.startswith("state"):
            # Parse all top-level states
            states, pos = _parse_all_states(lines, pos)
        elif line.startswith("transitions"):
            transitions_str, pos = _collect_block(lines, pos)
            transitions = _parse_transitions(transitions_str)
        elif line.startswith("guards"):
            guards_str, pos = _collect_block(lines, pos)
            guards = _parse_guards(guards_str)
        elif line.startswith("actions"):
            actions_str, pos = _collect_block(lines, pos)
            actions = _parse_actions(actions_str)
        else:
            pos += 1

    return MachineDef(
        name=machine_name,
        context=context,
        events=events,
        states=states,
        transitions=transitions,
        guards=guards,
        actions=actions,
    )


def _collect_block(lines: list[str], start: int) -> tuple[str, int]:
    """Collect the content of a block that starts with { and ends with }."""
    pos = start + 1  # Skip the header line
    brace_count = 1

    while pos < len(lines) and brace_count > 0:
        line = lines[pos].strip()
        brace_count += line.count("{") - line.count("}")
        pos += 1

    content = "\n".join(lines[start + 1:pos - 1])
    return content, pos


def _parse_all_states(lines: list[str], start: int) -> tuple[list[StateDef], int]:
    """Parse all states starting from position, handling nested states."""
    states: list[StateDef] = []
    pos = start

    while pos < len(lines):
        line = lines[pos].strip()

        if not line:
            pos += 1
            continue

        if not line.startswith("state"):
            break

        # Parse this state and all its nested states
        state_def, consumed, nested_pos = _parse_state(lines, pos)
        if state_def:
            states.append(state_def)
        pos = nested_pos

    return states, pos


def _parse_state(lines: list[str], start: int) -> tuple[StateDef | None, int, int]:
    """
    Parse a single state definition and its nested states.

    Returns:
        (state_def, lines_consumed, end_position)
    """
    if start >= len(lines):
        return None, 0, start

    header_line = lines[start].strip()
    if not header_line.startswith("state"):
        return None, 0, start + 1

    # Parse header: state name [annotations]
    match = re.match(r"state\s+(\w+)(?:\s+\[(.*?)\])?", header_line)
    if not match:
        return None, 0, start + 1

    name = match.group(1)
    annotations_str = match.group(2) or ""

    is_initial = "initial" in annotations_str.split(",")
    is_final = "final" in annotations_str.split(",")

    state_def = StateDef(
        name=name,
        is_initial=is_initial,
        is_final=is_final,
    )

    # Check if state has a body
    if "{" not in header_line:
        # No body - single line state
        return state_def, 1, start + 1

    # Collect body content until matching brace
    body_lines: list[str] = []
    pos = start + 1
    brace_count = header_line.count("{") - header_line.count("}")

    while pos < len(lines) and brace_count > 0:
        line = lines[pos].strip()
        brace_count += line.count("{") - line.count("}")

        if brace_count > 0 and line:
            body_lines.append(line)

        pos += 1

    # Parse body properties and collect nested state lines
    nested_state_lines: list[str] = []
    for body_line in body_lines:
        if body_line.startswith("state "):
            nested_state_lines.append(body_line)
        elif body_line.startswith("description:"):
            state_def.description = body_line.split(":", 1)[1].strip().strip('"')
        elif body_line.startswith("on_entry:"):
            m = re.match(r"on_entry:\s*->\s*(\w+)", body_line)
            if m:
                state_def.on_entry = m.group(1)
        elif body_line.startswith("on_exit:"):
            m = re.match(r"on_exit:\s*->\s*(\w+)", body_line)
            if m:
                state_def.on_exit = m.group(1)
        elif body_line.startswith("timeout:"):
            m = re.match(r"timeout:\s*(\d+)(?:s)?\s*->\s*(\w+)", body_line)
            if m:
                state_def.timeout = {"duration": m.group(1), "target": m.group(2)}

    # Parse nested states directly from body_lines
    if nested_state_lines:
        nested_states = _parse_nested_states(body_lines, name)
        if nested_states:
            state_def.contains = nested_states

    return state_def, pos - start, pos


def _parse_nested_states(body_lines: list[str], parent_name: str) -> list[StateDef]:
    """
    Parse nested states from a list of body lines.

    Args:
        body_lines: Lines inside a compound state's body
        parent_name: Name of the parent state

    Returns:
        List of parsed nested StateDef objects
    """
    nested_states: list[StateDef] = []
    i = 0

    while i < len(body_lines):
        line = body_lines[i].strip()

        if not line or line == "}":
            i += 1
            continue

        if not line.startswith("state "):
            i += 1
            continue

        # Parse this nested state
        state_def, consumed = _parse_nested_state(body_lines, i)
        if state_def:
            state_def.parent = parent_name
            nested_states.append(state_def)
            i += consumed
        else:
            i += 1

    return nested_states


def _parse_nested_state(body_lines: list[str], start: int) -> tuple[StateDef | None, int]:
    """
    Parse a single nested state definition from body_lines.

    Args:
        body_lines: Lines inside the parent state's body
        start: Index in body_lines where this state begins

    Returns:
        (state_def, lines_consumed)
    """
    if start >= len(body_lines):
        return None, 0

    header_line = body_lines[start].strip()
    if not header_line.startswith("state "):
        return None, 0

    # Parse header: state name [annotations]
    match = re.match(r"state\s+(\w+)(?:\s+\[(.*?)\])?", header_line)
    if not match:
        return None, 0

    name = match.group(1)
    annotations_str = match.group(2) or ""

    is_initial = "initial" in annotations_str.split(",")
    is_final = "final" in annotations_str.split(",")

    state_def = StateDef(
        name=name,
        is_initial=is_initial,
        is_final=is_final,
    )

    # Check if state has a body (contains braces)
    if "{" not in header_line and "}" not in header_line:
        # Single line state - consumed is 1
        return state_def, 1

    # Find the body bounds - find matching closing brace
    body_start = start + 1
    body_end = body_start

    # Count braces to find nested state boundaries
    brace_count = 1
    while body_end < len(body_lines) and brace_count > 0:
        line = body_lines[body_end].strip()
        brace_count += line.count("{") - line.count("}")
        body_end += 1

    # Extract body content (excluding braces)
    body_content: list[str] = []
    for j in range(body_start, body_end - 1):
        line = body_lines[j].strip()
        if line and line != "{" and line != "}":
            body_content.append(line)

    # Parse body properties
    inner_nested_lines: list[str] = []
    for body_line in body_content:
        if body_line.startswith("state "):
            inner_nested_lines.append(body_line)
        elif body_line.startswith("description:"):
            state_def.description = body_line.split(":", 1)[1].strip().strip('"')
        elif body_line.startswith("on_entry:"):
            m = re.match(r"on_entry:\s*->\s*(\w+)", body_line)
            if m:
                state_def.on_entry = m.group(1)
        elif body_line.startswith("on_exit:"):
            m = re.match(r"on_exit:\s*->\s*(\w+)", body_line)
            if m:
                state_def.on_exit = m.group(1)
        elif body_line.startswith("timeout:"):
            m = re.match(r"timeout:\s*(\d+)(?:s)?\s*->\s*(\w+)", body_line)
            if m:
                state_def.timeout = {"duration": m.group(1), "target": m.group(2)}

    # Recursively parse nested states
    if inner_nested_lines:
        inner_nested = _parse_nested_states(body_content, name)
        if inner_nested:
            state_def.contains = inner_nested

    # Lines consumed = everything up to and including closing brace
    lines_consumed = body_end - start

    return state_def, lines_consumed


def _parse_context(content: str) -> dict[str, Any]:
    """Parse context block."""
    context: dict[str, Any] = {}

    for line in content.strip().split("\n"):
        line = line.strip()
        if not line or line in ("{", "}"):
            continue

        match = re.match(r"(\w+)\s*:\s*(\w+)(?:\s*=\s*(.*))?", line)
        if match:
            name = match.group(1)
            default_str = match.group(3)

            default_value: Any = None
            if default_str:
                default_str = default_str.strip()
                if default_str.startswith('"') or default_str.startswith("'"):
                    default_value = default_str.strip('"\'')
                elif default_str in ("true", "false"):
                    default_value = default_str == "true"
                elif default_str.isdigit():
                    default_value = int(default_str)
                else:
                    try:
                        default_value = float(default_str)
                    except ValueError:
                        default_value = default_str

            context[name] = default_value

    return context


def _parse_events(content: str) -> list[str]:
    """Parse events block."""
    events: list[str] = []

    for line in content.strip().split("\n"):
        line = line.strip()
        if not line or line in ("{", "}"):
            continue

        parts = [p.strip() for p in line.split(",")]
        for part in parts:
            if part:
                events.append(part)

    return events


def _parse_transitions(content: str) -> list[Transition]:
    """Parse transitions block."""
    transitions: list[Transition] = []

    for line in content.strip().split("\n"):
        line = line.strip()
        if not line or line in ("{", "}"):
            continue

        match = re.match(
            r"(\w+)\s*\+\s*(\w+)(?:\s*\[([^\]]+)\])?\s*->\s*(\w+)(?:\s*:\s*(\w+))?",
            line
        )
        if match:
            transitions.append(Transition(
                source=match.group(1),
                event=match.group(2),
                guard=match.group(3),
                target=match.group(4),
                action=match.group(5),
            ))

    return transitions


def _parse_guards(content: str) -> dict[str, GuardExpression]:
    """Parse guards block."""
    guards: dict[str, GuardExpression] = {}

    for line in content.strip().split("\n"):
        line = line.strip()
        if not line or line in ("{", "}"):
            continue

        match = re.match(r"(\w+)\s*:\s*(.+)", line)
        if match:
            name = match.group(1)
            expr_str = match.group(2).strip()

            if expr_str == "true":
                guards[name] = GuardTrue()
            elif expr_str == "false":
                guards[name] = GuardFalse()
            else:
                guards[name] = GuardTrue()

    return guards


def _parse_actions(content: str) -> list[ActionSignature]:
    """Parse actions block."""
    actions: list[ActionSignature] = []

    for line in content.strip().split("\n"):
        line = line.strip()
        if not line or line in ("{", "}"):
            continue

        match = re.match(
            r"(\w+)\s*:\s*(?:\(([^)]*)\))?\s*->\s*(\w+)(?:\s*\+\s*Effect<(\w+)>)?",
            line
        )
        if match:
            name = match.group(1)
            params_str = match.group(2) or ""
            return_type = match.group(3)
            effect_type = match.group(4)

            parameters: list[str] = []
            if params_str:
                parameters = [p.strip().split(":")[0].strip() for p in params_str.split(",")]

            actions.append(ActionSignature(
                name=name,
                parameters=parameters,
                return_type=return_type,
                has_effect=effect_type is not None,
                effect_type=effect_type,
            ))

    return actions
