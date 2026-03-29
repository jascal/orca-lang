---
"@orcalang/orca-mcp-server": patch
"@orcalang/orca-lang": patch
---

feat(mcp): generate_machine auto-routes to single or multi-machine based on spec heuristic

- `generate_machine` now calls `generateAutoSkill` which detects coordinator/orchestrator specs and routes to multi-machine generation automatically; returns `is_multi` flag in result
- Separate verify step: `generate_machine` (and `generate_multi_machine`) now return a draft in one LLM call with no internal verify loop — callers explicitly chain `verify_machine` → `refine_machine` → `verify_machine` as discrete visible tool calls
- New exports: `generateAutoSkill`, `generateOrcaDraftSkill`, `generateOrcaMultiDraftSkill`, `detectMultiMachine`
- Removed `max_iterations` from `generate_machine` and `generate_multi_machine` tool schemas
