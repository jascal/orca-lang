"""Adapter layer: extract machines from .orca.md code blocks for the local DSL parser.

The runtime-python markdown parser skips code blocks (```orca ...```), so we can't
use it directly on files that embed machine definitions inside code blocks.
Instead, we extract machines from code blocks and parse them with the local DSL parser.

This module provides parse_orca_md_multi() which extracts ```orca blocks from
workflows.orca.md and parses each with the local parse_orca() function,
ensuring the file uses the same markdown format that orca-lang core produces.
"""

import re
from pathlib import Path
from typing import Optional

from orca.types import (
    MachineDefinition as LocalMachineDef,
    State as LocalState,
    Transition as LocalTransition,
    Context as LocalContext,
    StateType as LocalStateType,
    Event as LocalEvent,
)
from orca.parser import parse_orca as local_parse_orca


def _extract_code_blocks(source: str) -> list[tuple[str, str]]:
    """
    Extract (language, code) pairs from fenced code blocks in markdown.
    E.g., ```orca ...``` returns ('orca', 'machine X ...').
    """
    pattern = re.compile(r"```(\w*)\n(.*?)```", re.DOTALL)
    return [(lang, code.strip()) for lang, code in pattern.findall(source)]


def parse_orca_md_multi(source: str) -> list[LocalMachineDef]:
    """
    Parse Orca machines from a .orca.md file's code blocks.

    The file may contain ```orca blocks with machine definitions, optionally
    mixed with markdown documentation. Only ```orca blocks are parsed.
    Machines are separated by --- lines within the code blocks.

    Returns a list of local MachineDefinition objects.
    """
    blocks = _extract_code_blocks(source)
    machines: list[LocalMachineDef] = []

    for lang, code in blocks:
        if lang not in ("orca", ""):
            continue

        # Split on --- separators (multi-machine files)
        machine_sources = re.split(r"\n---\n", code)
        for machine_src in machine_sources:
            machine_src = machine_src.strip()
            if not machine_src:
                continue
            # Skip if it looks like a comment or heading (not a machine def)
            if machine_src.startswith("#") or not machine_src.startswith("machine "):
                continue
            try:
                local_def = local_parse_orca(machine_src)
                machines.append(local_def)
            except Exception:
                # If DSL parse fails, skip this block
                pass

    return machines


def load_workflows_md(filepath: str | Path) -> str:
    """Load a .orca.md file's raw content."""
    return Path(filepath).read_text()

