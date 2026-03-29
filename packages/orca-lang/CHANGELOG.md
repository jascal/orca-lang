# @orcalang/orca-lang

## 0.1.4

### Patch Changes

- 86c9661: fix: check ORCA_API_KEY in AnthropicProvider so MCP server generate_machine tool works with Claude Code env block config
- 392a9fb: feat(mcp): generate_machine auto-routes to single or multi-machine based on spec heuristic

  - `generate_machine` now calls `generateAutoSkill` which detects coordinator/orchestrator specs and routes to multi-machine generation automatically; returns `is_multi` flag in result
  - Separate verify step: `generate_machine` (and `generate_multi_machine`) now return a draft in one LLM call with no internal verify loop — callers explicitly chain `verify_machine` → `refine_machine` → `verify_machine` as discrete visible tool calls
  - New exports: `generateAutoSkill`, `generateOrcaDraftSkill`, `generateOrcaMultiDraftSkill`, `detectMultiMachine`
  - Removed `max_iterations` from `generate_machine` and `generate_multi_machine` tool schemas

## 0.1.3

### Patch Changes

- Bump @orcalang/orca-lang

## 0.1.2

### Patch Changes

- Bump @orcalang/orca-lang
- 17526ad: ci: trigger release with patch bump after MCP server and parser improvements
