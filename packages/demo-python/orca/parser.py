"""Orca markdown parser - Parses .orca.md format into MachineDefinition.

Supports the markdown table format:
    # machine Name
    ## context
    | Field | Type | Default |
    ## events
    - EVENT_NAME
    ## state Name [initial/final]
    > on EVENT -> target
    ## transitions
    | Source | Event | Guard | Target | Action |

Multi-machine files use --- separators.
"""

from __future__ import annotations

import re
from typing import List, Tuple, Optional, Any

from orca.types import (
    MachineDefinition, State, Transition, Context,
    StateType, Transition as TransitionType
)


def _split_table_row(line: str) -> List[str]:
    """Split a markdown table row into cells."""
    cells = [c.strip() for c in line.split("|")]
    if cells and cells[0] == "":
        cells.pop(0)
    if cells and cells[-1] == "":
        cells.pop()
    return cells


def _parse_value(s: str) -> Any:
    """Parse a context value string into a Python value."""
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
    if re.match(r"^\d+\.\d+$", s):
        return float(s)
    return s


def _parse_markdown_elements(source: str) -> List[Any]:
    """Parse markdown source into structural elements."""
    lines = source.split("\n")
    elements: List[Any] = []
    i = 0

    while i < len(lines):
        line = lines[i].strip()

        # Skip empty lines
        if not line:
            i += 1
            continue

        # Separator
        if re.match(r"^---+$", line):
            elements.append({"kind": "separator"})
            i += 1
            continue

        # Headings
        heading_match = re.match(r"^(#{1,6})\s+(.+)$", line)
        if heading_match:
            level = len(heading_match.group(1))
            text = heading_match.group(2).strip()
            elements.append({"kind": "heading", "level": level, "text": text})
            i += 1
            continue

        # Table row
        if line.startswith("|"):
            table_rows: List[str] = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                table_rows.append(lines[i].strip())
                i += 1
            if len(table_rows) >= 2:
                # Check if second row is a separator
                is_separator = bool(re.match(r"^\|[\s\-:|]+\|$", table_rows[1]))
                data_start = 2 if is_separator else 1
                headers = _split_table_row(table_rows[0])
                rows = [_split_table_row(table_rows[j]) for j in range(data_start, len(table_rows))]
                elements.append({"kind": "table", "headers": headers, "rows": rows})
            continue

        # Blockquote
        if line.startswith(">"):
            quote_lines = []
            while i < len(lines) and lines[i].strip().startswith(">"):
                quote_lines.append(re.sub(r"^>\s*", "", lines[i].strip()))
                i += 1
            elements.append({"kind": "blockquote", "text": " ".join(quote_lines)})
            continue

        # Bullet list
        if line.startswith("- "):
            items: List[str] = []
            while i < len(lines) and lines[i].strip().startswith("- "):
                items.append(lines[i].strip()[2:].strip())
                i += 1
            elements.append({"kind": "bullet_list", "items": items})
            continue

        i += 1

    return elements


def _find_column_index(headers: List[str], name: str) -> int:
    """Find column index by header name (case-insensitive)."""
    name_lower = name.lower()
    for idx, h in enumerate(headers):
        if h.lower() == name_lower:
            return idx
    return -1


def _parse_machine_chunk(elements: List[Any]) -> MachineDefinition:
    """Parse a single machine from markdown elements."""
    name = "UnnamedMachine"
    context_data: dict[str, Any] = {}
    states: List[State] = []
    transitions: List[TransitionType] = []
    initial_state = ""
    current_state_name: Optional[str] = None

    i = 0
    while i < len(elements):
        el = elements[i]

        if el["kind"] == "heading" and el["level"] == 1:
            # Machine heading: # machine Name
            if el["text"].startswith("machine "):
                name = el["text"][8:].strip()
            i += 1
            continue

        if el["kind"] == "heading" and el["level"] == 2:
            section = el["text"].lower()
            next_el = elements[i + 1] if i + 1 < len(elements) else None

            # ## context
            if section == "context" and next_el and next_el["kind"] == "table":
                fi = _find_column_index(next_el["headers"], "field")
                di = _find_column_index(next_el["headers"], "default")
                for row in next_el["rows"]:
                    field_name = row[fi].strip() if fi >= 0 and fi < len(row) else ""
                    default_str = row[di].strip() if di >= 0 and di < len(row) else ""
                    if field_name:
                        context_data[field_name] = _parse_value(default_str)
                i += 2
                continue

            # ## events
            if section == "events" and next_el and next_el["kind"] == "bullet_list":
                i += 2
                continue

            # ## transitions
            if section == "transitions" and next_el and next_el["kind"] == "table":
                si = _find_column_index(next_el["headers"], "source")
                ei = _find_column_index(next_el["headers"], "event")
                gi = _find_column_index(next_el["headers"], "guard")
                ti = _find_column_index(next_el["headers"], "target")
                ai = _find_column_index(next_el["headers"], "action")
                for row in next_el["rows"]:
                    source = row[si].strip() if si >= 0 and si < len(row) else ""
                    event = row[ei].strip() if ei >= 0 and ei < len(row) else ""
                    guard = row[gi].strip() if gi >= 0 and gi < len(row) else ""
                    target = row[ti].strip() if ti >= 0 and ti < len(row) else ""
                    action = row[ai].strip() if ai >= 0 and ai < len(row) else ""
                    transitions.append(TransitionType(
                        source=source,
                        event=event,
                        target=target,
                        guard=guard if guard else None,
                        action=action if action and action != "_" else None,
                    ))
                i += 2
                continue

            # ## state Name [annotations] "description"
            state_match = re.match(r"^state\s+(\w+)(?:\[(\w+)\])?(?:\s+[\"\'](.+?)[\"\'])?", section)
            if state_match:
                state_name = state_match.group(1)
                annotations = state_match.group(2) or ""
                description = state_match.group(3) or ""

                is_initial = "initial" in annotations
                is_final = "final" in annotations
                state_type = StateType.INITIAL if is_initial else (StateType.FINAL if is_final else StateType.NORMAL)

                state = State(
                    name=state_name,
                    state_type=state_type,
                    description=description,
                )
                states.append(state)
                current_state_name = state_name

                if is_initial:
                    initial_state = state_name

                i += 1
                continue

            i += 1
            continue

        # Blockquote under a state: > on EVENT -> TARGET
        if el["kind"] == "blockquote" and current_state_name:
            # Parse: > on EVENT -> TARGET : action
            trans_match = re.match(r"on\s+(\w+)\s*(?:->\s*(\w+))?(?:\s*:\s*(\w+))?", el["text"])
            if trans_match:
                event = trans_match.group(1)
                target = trans_match.group(2) or ""
                action = trans_match.group(3) or ""
                # Find the state object and add transition
                for state in states:
                    if state.name == current_state_name:
                        state.transitions.append(TransitionType(
                            source=current_state_name,
                            event=event,
                            target=target,
                            guard=None,
                            action=action if action else None,
                        ))
                        break
            i += 1
            continue

        # Separator ends current state context
        if el["kind"] == "separator":
            current_state_name = None
            i += 1
            continue

        i += 1

    # If no initial state found, use first state
    if not initial_state and states:
        initial_state = states[0].name

    return MachineDefinition(
        name=name,
        context=Context(data=context_data),
        states=states,
        transitions=transitions,
        initial_state=initial_state,
    )


def parse_orca(source: str) -> MachineDefinition:
    """Parse Orca markdown source into a MachineDefinition.

    Handles both single-machine and multi-machine (--- separated) files.
    """
    # Split on separators for multi-machine files
    chunks = re.split(r"\n---\n", source.strip())
    if len(chunks) > 1:
        # Parse all chunks and return the first machine
        # (for backward compatibility with single-machine callers)
        for chunk in chunks:
            chunk = chunk.strip()
            if not chunk:
                continue
            # Skip non-machine chunks (like the DT documentation)
            if not re.search(r"#\s*machine\s+\w+", chunk):
                continue
            elements = _parse_markdown_elements(chunk)
            return _parse_machine_chunk(elements)

    elements = _parse_markdown_elements(source.strip())
    return _parse_machine_chunk(elements)


def parse_orca_multi(source: str) -> List[MachineDefinition]:
    """Parse Orca markdown source into multiple MachineDefinitions."""
    chunks = re.split(r"\n---\n", source.strip())
    machines: List[MachineDefinition] = []

    for chunk in chunks:
        chunk = chunk.strip()
        if not chunk:
            continue
        # Skip non-machine chunks
        if not re.search(r"#\s*machine\s+\w+", chunk):
            continue
        try:
            elements = _parse_markdown_elements(chunk)
            machine = _parse_machine_chunk(elements)
            machines.append(machine)
        except Exception:
            pass

    return machines
