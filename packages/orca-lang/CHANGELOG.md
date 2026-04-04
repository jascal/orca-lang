# @orcalang/orca-lang

## 0.1.24

### Patch Changes

- Bump @orcalang/orca-lang

## 0.1.23

### Patch Changes

- Bump @orcalang/orca-lang

## 0.1.22

### Patch Changes

- Bump @orcalang/orca-lang

## 0.1.21

### Patch Changes

- Bump @orcalang/orca-lang

## 0.1.20

### Patch Changes

- Bump @orcalang/orca-lang

## 0.1.19

### Patch Changes

- Bump @orcalang/orca-lang

## 0.1.16

### Patch Changes

- Bump @orcalang/orca-lang

## 0.1.15

### Patch Changes

- Bump @orcalang/orca-lang

## 0.1.14

### Patch Changes

- Bump @orcalang/orca-lang

## 0.1.12

### Patch Changes

- fix(llm): use `max_completion_tokens` for o-series OpenAI models; omit `temperature` for reasoning models

---

## 0.1.11

### Patch Changes

- chore: version bump

---

## 0.1.10

### Patch Changes

- feat(examples): add `key-exchange.orca.md` — three-machine client/server key exchange protocol (Coordinator, Client, Server)
- feat(tests): 20 tests for key-exchange example covering parsing, verification, completeness, cross-machine analysis, Mermaid compilation, and round-trip
- docs: README Background section — name origin, Orca music sequencer disambiguation, halting problem relationship

---

## 0.1.9

### Patch Changes

- fix(ci): correct mcp-publisher binary download URL in release workflow

## 0.1.6

### Patch Changes

- feat(mcp): add `server_status` tool — returns version, active config, and `api_key_configured` boolean (credentials never exposed)

## 0.1.5

### Patch Changes

- Bump @orcalang/orca-lang

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
