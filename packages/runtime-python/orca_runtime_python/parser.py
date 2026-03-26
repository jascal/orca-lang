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
    GuardCompare,
    GuardAnd,
    GuardOr,
    GuardNot,
    GuardNullcheck,
    VariableRef,
    ValueRef,
    RegionDef,
    ParallelDef,
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
    has_parallel = False
    for body_line in body_lines:
        if body_line.startswith("state "):
            nested_state_lines.append(body_line)
        elif body_line.startswith("parallel"):
            has_parallel = True
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
        elif body_line.startswith("on_done:"):
            m = re.match(r"on_done:\s*->\s*(\w+)", body_line)
            if m:
                state_def.on_done = m.group(1)
        elif body_line.startswith("timeout:"):
            m = re.match(r"timeout:\s*(\d+)(?:s)?\s*->\s*(\w+)", body_line)
            if m:
                state_def.timeout = {"duration": m.group(1), "target": m.group(2)}
        elif body_line.startswith("ignore:"):
            events_str = body_line.replace("ignore:", "", 1).strip()
            ignored = [e.strip() for e in events_str.split(",") if e.strip()]
            state_def.ignored_events.extend(ignored)

    # Parse parallel block if present
    if has_parallel:
        parallel_def = _parse_parallel_block(body_lines)
        if parallel_def:
            state_def.parallel = parallel_def

    # Parse nested states directly from body_lines
    if nested_state_lines and not has_parallel:
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
    has_parallel = False
    for body_line in body_content:
        if body_line.startswith("state "):
            inner_nested_lines.append(body_line)
        elif body_line.startswith("parallel"):
            has_parallel = True
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
        elif body_line.startswith("on_done:"):
            m = re.match(r"on_done:\s*->\s*(\w+)", body_line)
            if m:
                state_def.on_done = m.group(1)
        elif body_line.startswith("timeout:"):
            m = re.match(r"timeout:\s*(\d+)(?:s)?\s*->\s*(\w+)", body_line)
            if m:
                state_def.timeout = {"duration": m.group(1), "target": m.group(2)}
        elif body_line.startswith("ignore:"):
            events_str = body_line.replace("ignore:", "", 1).strip()
            ignored = [e.strip() for e in events_str.split(",") if e.strip()]
            state_def.ignored_events.extend(ignored)

    # Parse parallel block if present
    if has_parallel:
        parallel_def = _parse_parallel_block(body_content)
        if parallel_def:
            state_def.parallel = parallel_def

    # Recursively parse nested states
    if inner_nested_lines and not has_parallel:
        inner_nested = _parse_nested_states(body_content, name)
        if inner_nested:
            state_def.contains = inner_nested

    # Lines consumed = everything up to and including closing brace
    lines_consumed = body_end - start

    return state_def, lines_consumed


def _parse_parallel_block(body_lines: list[str]) -> ParallelDef | None:
    """
    Parse a parallel block from body lines.

    Expects lines like:
        parallel [sync: all_final] {
            region region_name {
                state child1 [initial]
                state child2 [final]
            }
            region region_name2 { ... }
        }
    """
    # Find the parallel line
    parallel_start = -1
    for i, line in enumerate(body_lines):
        if line.strip().startswith("parallel"):
            parallel_start = i
            break

    if parallel_start < 0:
        return None

    parallel_line = body_lines[parallel_start].strip()

    # Parse optional sync strategy
    sync: str | None = None
    sync_match = re.search(r'\[sync:\s*(\w+)\]', parallel_line)
    if sync_match:
        raw_sync = sync_match.group(1)
        # Convert underscore form to hyphen form
        sync = raw_sync.replace("_", "-")

    # Collect all lines inside the parallel block
    brace_count = parallel_line.count("{") - parallel_line.count("}")
    inner_lines: list[str] = []
    pos = parallel_start + 1

    while pos < len(body_lines) and brace_count > 0:
        line = body_lines[pos].strip()
        brace_count += line.count("{") - line.count("}")
        if brace_count > 0 and line:
            inner_lines.append(line)
        pos += 1

    # Parse regions from inner_lines
    regions: list[RegionDef] = []
    i = 0
    while i < len(inner_lines):
        line = inner_lines[i].strip()
        if line.startswith("region "):
            region_match = re.match(r"region\s+(\w+)", line)
            if region_match:
                region_name = region_match.group(1)
                # Collect region body
                region_brace = line.count("{") - line.count("}")
                region_body: list[str] = []
                j = i + 1
                while j < len(inner_lines) and region_brace > 0:
                    rline = inner_lines[j].strip()
                    region_brace += rline.count("{") - rline.count("}")
                    if region_brace > 0 and rline:
                        region_body.append(rline)
                    j += 1

                # Parse states within the region
                region_states = _parse_nested_states(region_body, region_name)
                regions.append(RegionDef(name=region_name, states=region_states))
                i = j
                continue
        i += 1

    if not regions:
        return None

    return ParallelDef(regions=regions, sync=sync)


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
            guards[name] = _parse_guard_expression(expr_str)

    return guards


# --- Guard expression parser ---
# Grammar:
#   expr     = or_expr
#   or_expr  = and_expr ('or' and_expr)*
#   and_expr = not_expr ('and' not_expr)*
#   not_expr = 'not' primary | primary
#   primary  = '(' expr ')' | 'true' | 'false' | comparison
#   comparison = var_path (op value)?
#   var_path = IDENT ('.' IDENT)*
#   op       = '==' | '!=' | '<' | '>' | '<=' | '>='
#   value    = NUMBER | STRING | 'true' | 'false' | 'null'

@dataclass
class _GToken:
    type: str  # ident, number, string, op, lparen, rparen, dot, eof
    value: str


def _tokenize_guard(input_str: str) -> list[_GToken]:
    """Tokenize a guard expression string."""
    tokens: list[_GToken] = []
    i = 0
    n = len(input_str)

    while i < n:
        c = input_str[i]

        # Skip whitespace
        if c.isspace():
            i += 1
            continue

        # String literal
        if c in ('"', "'"):
            quote = c
            s = ""
            i += 1
            while i < n and input_str[i] != quote:
                s += input_str[i]
                i += 1
            i += 1  # skip closing quote
            tokens.append(_GToken("string", s))
            continue

        # Two-char operators
        if i + 1 < n:
            two = input_str[i:i + 2]
            if two in ("==", "!=", "<=", ">="):
                tokens.append(_GToken("op", two))
                i += 2
                continue

        # Single-char operators
        if c in ("<", ">"):
            tokens.append(_GToken("op", c))
            i += 1
            continue

        if c == "(":
            tokens.append(_GToken("lparen", "("))
            i += 1
            continue
        if c == ")":
            tokens.append(_GToken("rparen", ")"))
            i += 1
            continue
        if c == ".":
            tokens.append(_GToken("dot", "."))
            i += 1
            continue

        # Number (including negative)
        if c.isdigit() or (c == "-" and i + 1 < n and input_str[i + 1].isdigit()):
            num = c
            i += 1
            while i < n and (input_str[i].isdigit() or input_str[i] == "."):
                num += input_str[i]
                i += 1
            tokens.append(_GToken("number", num))
            continue

        # Identifier
        if c.isalpha() or c == "_":
            ident = ""
            while i < n and (input_str[i].isalnum() or input_str[i] == "_"):
                ident += input_str[i]
                i += 1
            tokens.append(_GToken("ident", ident))
            continue

        # Skip unknown
        i += 1

    tokens.append(_GToken("eof", ""))
    return tokens


def _parse_guard_expression(input_str: str) -> GuardExpression:
    """Parse a guard expression string into a GuardExpression AST."""
    tokens = _tokenize_guard(input_str)
    pos = [0]  # mutable ref for nested functions

    def peek() -> _GToken:
        return tokens[pos[0]]

    def advance() -> _GToken:
        tok = tokens[pos[0]]
        pos[0] += 1
        return tok

    def parse_or() -> GuardExpression:
        left = parse_and()
        while peek().type == "ident" and peek().value == "or":
            advance()
            right = parse_and()
            left = GuardOr(left=left, right=right)
        return left

    def parse_and() -> GuardExpression:
        left = parse_not()
        while peek().type == "ident" and peek().value == "and":
            advance()
            right = parse_not()
            left = GuardAnd(left=left, right=right)
        return left

    def parse_not() -> GuardExpression:
        if peek().type == "ident" and peek().value == "not":
            advance()
            return GuardNot(expr=parse_primary())
        return parse_primary()

    def parse_primary() -> GuardExpression:
        tok = peek()

        # Parenthesized expression
        if tok.type == "lparen":
            advance()
            expr = parse_or()
            if peek().type == "rparen":
                advance()
            return expr

        # Literals
        if tok.type == "ident" and tok.value == "true":
            advance()
            return GuardTrue()
        if tok.type == "ident" and tok.value == "false":
            advance()
            return GuardFalse()

        # Variable path, possibly followed by comparison
        var_path = parse_var_path()

        # Check for "is null" / "is not null"
        if peek().type == "ident" and peek().value == "is":
            advance()
            if peek().type == "ident" and peek().value == "not":
                advance()
                if peek().type == "ident" and peek().value == "null":
                    advance()
                return GuardNullcheck(expr=var_path, is_null=False)
            if peek().type == "ident" and peek().value == "null":
                advance()
                return GuardNullcheck(expr=var_path, is_null=True)

        # Comparison operator
        if peek().type == "op":
            op = advance().value
            right = parse_value()
            # Special case: != null and == null
            if right.type == "null":
                return GuardNullcheck(expr=var_path, is_null=(op == "=="))
            return GuardCompare(op=_map_op(op), left=var_path, right=right)

        # Bare variable = truthy check (not null)
        return GuardNullcheck(expr=var_path, is_null=False)

    def parse_var_path() -> VariableRef:
        parts: list[str] = []
        if peek().type == "ident":
            parts.append(advance().value)
            while peek().type == "dot":
                advance()
                if peek().type == "ident":
                    parts.append(advance().value)
        return VariableRef(path=parts)

    def parse_value() -> ValueRef:
        tok = peek()
        if tok.type == "number":
            advance()
            num = float(tok.value)
            if num == int(num):
                num = int(num)
            return ValueRef(type="number", value=num)
        if tok.type == "string":
            advance()
            return ValueRef(type="string", value=tok.value)
        if tok.type == "ident":
            advance()
            if tok.value == "null":
                return ValueRef(type="null", value=None)
            if tok.value == "true":
                return ValueRef(type="boolean", value=True)
            if tok.value == "false":
                return ValueRef(type="boolean", value=False)
            return ValueRef(type="string", value=tok.value)
        advance()
        return ValueRef(type="null", value=None)

    return parse_or()


def _map_op(op: str) -> str:
    """Map operator string to internal op name."""
    return {
        "==": "eq",
        "!=": "ne",
        "<": "lt",
        ">": "gt",
        "<=": "le",
        ">=": "ge",
    }.get(op, "eq")


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
