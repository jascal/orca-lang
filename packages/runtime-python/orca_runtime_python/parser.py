"""
Orca Markdown parser.

Parses Orca machine definition text in markdown (.orca.md) format
into MachineDef objects. Supports hierarchical and parallel states.
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
    EffectDef,
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
    InvokeDef,
)


class ParseError(Exception):
    """Raised when parsing fails."""
    pass


# ============================================================
# Markdown (.orca.md) Parser
# ============================================================

@dataclass
class _MdHeading:
    kind: str = "heading"
    level: int = 0
    text: str = ""


@dataclass
class _MdTable:
    kind: str = "table"
    headers: list[str] = field(default_factory=list)
    rows: list[list[str]] = field(default_factory=list)


@dataclass
class _MdBulletList:
    kind: str = "bullets"
    items: list[str] = field(default_factory=list)


@dataclass
class _MdBlockquote:
    kind: str = "blockquote"
    text: str = ""


@dataclass
class _MdSeparator:
    """Machine separator (--- between machines in multi-machine files)."""
    kind: str = "separator"


_MdElement = _MdHeading | _MdTable | _MdBulletList | _MdBlockquote | _MdSeparator


def _parse_markdown_structure(source: str) -> list[_MdElement]:
    """Phase 1: Parse markdown into structural elements."""
    lines = source.split("\n")
    elements: list[_MdElement] = []
    i = 0

    while i < len(lines):
        trimmed = lines[i].strip()
        if not trimmed:
            i += 1
            continue

        # Skip fenced code blocks
        if trimmed.startswith("```"):
            i += 1
            while i < len(lines) and not lines[i].strip().startswith("```"):
                i += 1
            if i < len(lines):
                i += 1
            continue

        # Heading
        heading_match = re.match(r"^(#{1,6})\s+(.+)$", trimmed)
        if heading_match:
            elements.append(_MdHeading(
                level=len(heading_match.group(1)),
                text=heading_match.group(2).strip(),
            ))
            i += 1
            continue

        # Separator between machines (--- on its own line)
        if re.match(r"^---+$", trimmed):
            elements.append(_MdSeparator())
            i += 1
            continue

        # Blockquote
        if trimmed.startswith(">"):
            quote_lines: list[str] = []
            while i < len(lines) and lines[i].strip().startswith(">"):
                quote_lines.append(re.sub(r"^>\s*", "", lines[i].strip()))
                i += 1
            elements.append(_MdBlockquote(text="\n".join(quote_lines)))
            continue

        # Table
        if trimmed.startswith("|"):
            table_lines: list[str] = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                table_lines.append(lines[i].strip())
                i += 1
            if len(table_lines) >= 2:
                headers = _split_table_row(table_lines[0])
                is_separator = bool(re.match(r"^\|[\s\-:|]+\|$", table_lines[1]))
                data_start = 2 if is_separator else 1
                rows = [_split_table_row(table_lines[j]) for j in range(data_start, len(table_lines))]
                elements.append(_MdTable(headers=headers, rows=rows))
            continue

        # Bullet list
        if trimmed.startswith("- "):
            items: list[str] = []
            while i < len(lines) and lines[i].strip().startswith("- "):
                items.append(lines[i].strip()[2:].strip())
                i += 1
            elements.append(_MdBulletList(items=items))
            continue

        # Skip other text
        i += 1

    return elements


def _split_table_row(line: str) -> list[str]:
    """Split a markdown table row into cells."""
    cells = [c.strip() for c in line.split("|")]
    if cells and cells[0] == "":
        cells.pop(0)
    if cells and cells[-1] == "":
        cells.pop()
    return cells


def _strip_backticks(text: str) -> str:
    """Remove surrounding backticks from a string."""
    if text.startswith("`") and text.endswith("`"):
        return text[1:-1]
    return text


def _find_column_index(headers: list[str], name: str) -> int:
    """Find column index by header name (case-insensitive)."""
    name_lower = name.lower()
    for idx, h in enumerate(headers):
        if h.lower() == name_lower:
            return idx
    return -1


def _parse_md_annotations(text: str) -> dict[str, Any]:
    """Parse state annotations like [initial, final, parallel, sync: all-final]."""
    result: dict[str, Any] = {
        "is_initial": False,
        "is_final": False,
        "is_parallel": False,
    }
    bracket_match = re.search(r"\[(.+)\]", text)
    if bracket_match:
        for part in [p.strip() for p in bracket_match.group(1).split(",")]:
            if part == "initial":
                result["is_initial"] = True
            elif part == "final":
                result["is_final"] = True
            elif part == "parallel":
                result["is_parallel"] = True
            elif part.startswith("sync:"):
                v = part[5:].strip().replace("_", "-")
                if v in ("all-final", "any-final", "custom"):
                    result["sync_strategy"] = v
    return result


@dataclass
class _MdStateEntry:
    entry_type: str  # 'state' or 'region'
    level: int = 0
    name: str = ""
    is_initial: bool = False
    is_final: bool = False
    is_parallel: bool = False
    sync_strategy: str | None = None
    description: str | None = None
    on_entry: str | None = None
    on_exit: str | None = None
    on_done: str | None = None
    timeout: dict[str, str] | None = None
    ignored_events: list[str] = field(default_factory=list)
    invoke: InvokeDef | None = None
    _pending_on_error: str | None = None  # temp: on_error parsed before invoke


def _parse_md_state_bullet(entry: _MdStateEntry, text: str) -> None:
    """Parse a bullet list item belonging to a state."""
    if text.startswith("on_entry:"):
        val = text[9:].strip()
        if val.startswith("->"):
            val = val[2:].strip()
        entry.on_entry = val
    elif text.startswith("on_exit:"):
        val = text[8:].strip()
        if val.startswith("->"):
            val = val[2:].strip()
        entry.on_exit = val
    elif text.startswith("timeout:"):
        rest = text[8:].strip()
        arrow_idx = rest.find("->")
        if arrow_idx != -1:
            entry.timeout = {
                "duration": rest[:arrow_idx].strip(),
                "target": rest[arrow_idx + 2:].strip(),
            }
    elif text.startswith("ignore:"):
        names = [e.strip() for e in text[7:].strip().split(",") if e.strip()]
        entry.ignored_events.extend(names)
    elif text.startswith("on_done:"):
        val = text[8:].strip()
        if val.startswith("->"):
            val = val[2:].strip()
        entry.on_done = val
        # Also set on_done on invoke if invoke exists
        if entry.invoke:
            entry.invoke.on_done = val
    elif text.startswith("on_error:"):
        val = text[9:].strip()
        if val.startswith("->"):
            val = val[2:].strip()
        # Store temporarily until invoke is parsed
        entry._pending_on_error = val
        if entry.invoke:
            entry.invoke.on_error = val
    elif text.startswith("invoke:"):
        rest = text[7:].strip()  # "MachineName" or "MachineName input: { ... }"
        machine_name = rest
        input_map: dict[str, str] | None = None

        # Check for input mapping
        input_match = re.search(r"input:\s*\{([^}]+)\}", rest)
        if input_match:
            machine_name = rest[:input_match.start()].strip()
            input_str = input_match.group(1)
            input_map = {}
            for pair in input_str.split(","):
                if ":" in pair:
                    key, value = pair.split(":", 1)
                    input_map[key.strip()] = value.strip()

        entry.invoke = InvokeDef(machine=machine_name, input=input_map)
        # Apply pending on_error if we already parsed it
        if entry._pending_on_error:
            entry.invoke.on_error = entry._pending_on_error


def _build_md_states_at_level(
    entries: list[_MdStateEntry], start_idx: int, level: int, parent_name: str | None = None
) -> tuple[list[StateDef], int]:
    """Build state hierarchy from flat entries at a given heading level."""
    states: list[StateDef] = []
    i = start_idx

    while i < len(entries):
        entry = entries[i]
        if entry.level < level:
            break
        if entry.entry_type == "region":
            break
        if entry.level > level:
            i += 1
            continue

        state = StateDef(
            name=entry.name,
            is_initial=entry.is_initial,
            is_final=entry.is_final,
        )
        if parent_name:
            state.parent = parent_name
        if entry.description:
            state.description = entry.description
        if entry.on_entry:
            state.on_entry = entry.on_entry
        if entry.on_exit:
            state.on_exit = entry.on_exit
        if entry.on_done:
            state.on_done = entry.on_done
        if entry.timeout:
            state.timeout = entry.timeout
        if entry.ignored_events:
            state.ignored_events = list(entry.ignored_events)
        if entry.invoke:
            state.invoke = entry.invoke

        i += 1

        if entry.is_parallel:
            parallel_def, i = _build_md_parallel_regions(
                entries, i, level + 1, entry.name, entry.sync_strategy
            )
            state.parallel = parallel_def
        elif i < len(entries) and entries[i].level == level + 1 and entries[i].entry_type == "state":
            child_states, i = _build_md_states_at_level(entries, i, level + 1, entry.name)
            state.contains = child_states

        states.append(state)

    return states, i


def _build_md_parallel_regions(
    entries: list[_MdStateEntry], start_idx: int, region_level: int,
    parent_name: str, sync_strategy: str | None = None
) -> tuple[ParallelDef, int]:
    """Build parallel regions from flat entries."""
    regions: list[RegionDef] = []
    i = start_idx

    while i < len(entries) and entries[i].level >= region_level:
        if entries[i].entry_type != "region" or entries[i].level != region_level:
            break

        region_name = entries[i].name
        i += 1

        region_states: list[StateDef] = []
        while i < len(entries) and entries[i].level > region_level:
            if entries[i].entry_type == "state" and entries[i].level == region_level + 1:
                e = entries[i]
                s = StateDef(
                    name=e.name,
                    is_initial=e.is_initial,
                    is_final=e.is_final,
                )
                s.parent = f"{parent_name}.{region_name}"
                if e.description:
                    s.description = e.description
                if e.on_entry:
                    s.on_entry = e.on_entry
                if e.on_exit:
                    s.on_exit = e.on_exit
                if e.timeout:
                    s.timeout = e.timeout
                if e.ignored_events:
                    s.ignored_events = list(e.ignored_events)
                if e.invoke:
                    s.invoke = e.invoke
                if e.on_done:
                    s.on_done = e.on_done
                region_states.append(s)
                i += 1
            else:
                break

        regions.append(RegionDef(name=region_name, states=region_states))

    return ParallelDef(regions=regions, sync=sync_strategy), i


def _parse_md_action_signature(name: str, text: str) -> ActionSignature:
    """Parse an action signature string like '(ctx, event) -> Context + Effect<T>'."""
    text = text.strip()
    paren_start = text.find("(")
    paren_end = text.find(")")
    params_str = text[paren_start + 1:paren_end].strip()

    parameters: list[str] = []
    if params_str:
        parameters = [p.strip().split(":")[0].strip() for p in params_str.split(",")]

    after_paren = text[paren_end + 1:].strip()
    arrow_idx = after_paren.find("->")
    return_part = after_paren[arrow_idx + 2:].strip()

    return_type = "Context"
    has_effect = False
    effect_type: str | None = None

    plus_idx = return_part.find("+")
    if plus_idx != -1:
        return_type = return_part[:plus_idx].strip()
        effect_match = re.search(r"Effect<(\w+)>", return_part[plus_idx + 1:])
        if effect_match:
            has_effect = True
            effect_type = effect_match.group(1)
    else:
        return_type = return_part

    return ActionSignature(
        name=name,
        parameters=parameters,
        return_type=return_type,
        has_effect=has_effect,
        effect_type=effect_type,
    )


# --- Guard expression parser (shared) ---
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


def _parse_machine_elements(elements: list[_MdElement]) -> MachineDef:
    """Parse a single machine from already-split elements."""
    machine_name = "unknown"
    context: dict[str, Any] = {}
    events: list[str] = []
    transitions: list[Transition] = []
    guards: dict[str, GuardExpression] = {}
    actions: list[ActionSignature] = []
    effects: list[EffectDef] = []
    state_entries: list[_MdStateEntry] = []
    current_state_entry: _MdStateEntry | None = None

    i = 0
    while i < len(elements):
        el = elements[i]

        if isinstance(el, _MdHeading):
            # Machine heading
            if el.level == 1 and el.text.startswith("machine "):
                machine_name = el.text[8:].strip()
                current_state_entry = None
                i += 1
                continue

            # Section headings
            section_name = el.text.lower()
            if section_name in ("context", "events", "transitions", "guards", "actions", "effects"):
                current_state_entry = None
                next_el = elements[i + 1] if i + 1 < len(elements) else None

                if section_name == "context" and isinstance(next_el, _MdTable):
                    fi = _find_column_index(next_el.headers, "field")
                    di = _find_column_index(next_el.headers, "default")
                    for row in next_el.rows:
                        name = row[fi].strip() if fi >= 0 and fi < len(row) else ""
                        default_str = row[di].strip() if di >= 0 and di < len(row) else ""
                        default_value: Any = None
                        if default_str:
                            if default_str.isdigit():
                                default_value = int(default_str)
                            elif re.match(r"^\d+\.\d+$", default_str):
                                default_value = float(default_str)
                            elif default_str in ("true", "false"):
                                default_value = default_str == "true"
                            elif default_str.startswith('"') or default_str.startswith("'"):
                                default_value = default_str.strip("\"'")
                            else:
                                default_value = default_str
                        context[name] = default_value
                    i += 2
                    continue

                elif section_name == "events" and isinstance(next_el, _MdBulletList):
                    for item in next_el.items:
                        for name in [n.strip() for n in item.split(",") if n.strip()]:
                            events.append(name)
                    i += 2
                    continue

                elif section_name == "transitions" and isinstance(next_el, _MdTable):
                    si = _find_column_index(next_el.headers, "source")
                    ei = _find_column_index(next_el.headers, "event")
                    gi = _find_column_index(next_el.headers, "guard")
                    ti = _find_column_index(next_el.headers, "target")
                    ai = _find_column_index(next_el.headers, "action")
                    for row in next_el.rows:
                        source = row[si].strip() if si >= 0 and si < len(row) else ""
                        event = row[ei].strip() if ei >= 0 and ei < len(row) else ""
                        guard_str = row[gi].strip() if gi >= 0 and gi < len(row) else ""
                        target = row[ti].strip() if ti >= 0 and ti < len(row) else ""
                        action_str = row[ai].strip() if ai >= 0 and ai < len(row) else ""
                        transitions.append(Transition(
                            source=source,
                            event=event,
                            guard=guard_str if guard_str else None,
                            target=target,
                            action=action_str if action_str and action_str != "_" else None,
                        ))
                    i += 2
                    continue

                elif section_name == "guards" and isinstance(next_el, _MdTable):
                    ni = _find_column_index(next_el.headers, "name")
                    ei = _find_column_index(next_el.headers, "expression")
                    for row in next_el.rows:
                        name = row[ni].strip() if ni >= 0 and ni < len(row) else ""
                        expr_str = _strip_backticks(row[ei].strip() if ei >= 0 and ei < len(row) else "")
                        guards[name] = _parse_guard_expression(expr_str)
                    i += 2
                    continue

                elif section_name == "actions" and isinstance(next_el, _MdTable):
                    ni = _find_column_index(next_el.headers, "name")
                    si = _find_column_index(next_el.headers, "signature")
                    for row in next_el.rows:
                        name = row[ni].strip() if ni >= 0 and ni < len(row) else ""
                        sig = _strip_backticks(row[si].strip() if si >= 0 and si < len(row) else "")
                        actions.append(_parse_md_action_signature(name, sig))
                    i += 2
                    continue

                elif section_name == "effects" and isinstance(next_el, _MdTable):
                    ni = _find_column_index(next_el.headers, "name")
                    ii = _find_column_index(next_el.headers, "input")
                    oi = _find_column_index(next_el.headers, "output")
                    for row in next_el.rows:
                        name = row[ni].strip() if ni >= 0 and ni < len(row) else ""
                        input_str = _strip_backticks(row[ii].strip() if ii >= 0 and ii < len(row) else "")
                        output_str = _strip_backticks(row[oi].strip() if oi >= 0 and oi < len(row) else "")
                        if name:
                            effects.append(EffectDef(name=name, input=input_str, output=output_str))
                    i += 2
                    continue

                i += 1
                continue

            # State heading
            state_match = re.match(r"^state\s+(\w+)(.*)", el.text)
            if state_match:
                annot = _parse_md_annotations(state_match.group(2).strip())
                current_state_entry = _MdStateEntry(
                    entry_type="state",
                    level=el.level,
                    name=state_match.group(1),
                    is_initial=annot["is_initial"],
                    is_final=annot["is_final"],
                    is_parallel=annot["is_parallel"],
                    sync_strategy=annot.get("sync_strategy"),
                )
                state_entries.append(current_state_entry)
                i += 1
                continue

            # Region heading
            region_match = re.match(r"^region\s+(\w+)$", el.text)
            if region_match:
                current_state_entry = None
                state_entries.append(_MdStateEntry(
                    entry_type="region",
                    level=el.level,
                    name=region_match.group(1),
                ))
                i += 1
                continue

            current_state_entry = None
            i += 1
            continue

        # Content belonging to current state
        if current_state_entry:
            if isinstance(el, _MdBlockquote):
                current_state_entry.description = el.text
            elif isinstance(el, _MdBulletList):
                for item in el.items:
                    _parse_md_state_bullet(current_state_entry, item)

        i += 1

    # Build state hierarchy
    base_level = state_entries[0].level if state_entries else 2
    states, _ = _build_md_states_at_level(state_entries, 0, base_level)

    return MachineDef(
        name=machine_name,
        context=context,
        events=events,
        states=states,
        transitions=transitions,
        guards=guards,
        actions=actions,
        effects=effects,
    )


def parse_orca_md(source: str) -> MachineDef:
    """
    Parse Orca markdown (.orca.md) format into a MachineDef.
    For multi-machine files, returns the first machine.
    """
    elements = _parse_markdown_structure(source)

    # Check for separators (multi-machine file)
    has_separators = any(isinstance(el, _MdSeparator) for el in elements)
    if has_separators:
        # Split by separators and parse the first machine
        chunks: list[list[_MdElement]] = []
        current_chunk: list[_MdElement] = []
        for el in elements:
            if isinstance(el, _MdSeparator):
                if current_chunk:
                    chunks.append(current_chunk)
                    current_chunk = []
            else:
                current_chunk.append(el)
        if current_chunk:
            chunks.append(current_chunk)
        return _parse_machine_elements(chunks[0]) if chunks else _parse_machine_elements(elements)

    return _parse_machine_elements(elements)


def parse_orca_md_multi(source: str) -> list[MachineDef]:
    """
    Parse Orca markdown (.orca.md) format into multiple MachineDefs.
    For single-machine files, returns a list with one element.
    """
    elements = _parse_markdown_structure(source)

    # Check for separators (multi-machine file)
    has_separators = any(isinstance(el, _MdSeparator) for el in elements)
    if has_separators:
        # Split by separators
        chunks: list[list[_MdElement]] = []
        current_chunk: list[_MdElement] = []
        for el in elements:
            if isinstance(el, _MdSeparator):
                if current_chunk:
                    chunks.append(current_chunk)
                    current_chunk = []
            else:
                current_chunk.append(el)
        if current_chunk:
            chunks.append(current_chunk)
        return [_parse_machine_elements(chunk) for chunk in chunks]

    return [_parse_machine_elements(elements)]


def parse_orca_auto(source: str, filename: str | None = None) -> MachineDef:
    """
    Auto-detect format and parse Orca machine definition.
    Uses filename extension if provided, otherwise sniffs content.
    """
    if filename and (filename.endswith(".orca.md") or filename.endswith(".md")):
        return parse_orca_md(source)
    # Content sniffing: markdown starts with # heading
    if re.search(r"^\s*#\s+machine\s+", source, re.MULTILINE):
        return parse_orca_md(source)
    # Fallback to markdown for any other case
    return parse_orca_md(source)
