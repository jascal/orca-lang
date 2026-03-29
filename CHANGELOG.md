# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [v0.1.9] — 2026-03-29

### Fixed

- `release.yml`: correct `mcp-publisher` binary download URL (`mcp-publisher_linux_amd64.tar.gz` was missing the `mcp-publisher_` prefix, causing curl to fetch a 404 and tar to fail with "not in gzip format").

---

## [v0.1.6] — 2026-03-29

### Added

- `server_status` MCP tool: returns server version, Node.js version, active LLM config (provider, model, base_url, code_generator, max_tokens, temperature), and `api_key_configured` boolean. API keys and credentials are never included in the response.

---

## [v0.1.5] — 2026-03-29

### Fixed

- `@orcalang/orca-lang`: check `ORCA_API_KEY` in `AnthropicProvider` so the MCP server `generate_machine` tool works with Claude Code env-block config.

### Added

- `generate_machine` (MCP) now auto-routes: specs that mention a coordinator, orchestrator, or multiple independently-lifecycled sub-processes are routed to multi-machine generation automatically. Result includes an `is_multi` flag.
- Discrete verify step: `generate_machine` and `generate_multi_machine` return a single-LLM-call draft with no internal verify loop — callers chain `verify_machine` → `refine_machine` → `verify_machine` as separately-visible tool calls.
- New exports from `@orcalang/orca-lang/skills`: `generateAutoSkill`, `generateOrcaDraftSkill`, `generateOrcaMultiDraftSkill`, `detectMultiMachine`.
- `max_iterations` removed from `generate_machine` / `generate_multi_machine` MCP tool schemas.
- README: Skills & MCP setup section with install instructions for Claude Desktop and Claude Code.

---

## [v0.1.1] — 2026-03-28

### Fixed

- `@orcalang/orca-mcp-server`: publish now uses `pnpm publish` so the `workspace:*` dependency on `@orcalang/orca-lang` is correctly resolved to `^0.1.1` in the published package. The `0.1.0` release was broken (`npx @orcalang/orca-mcp-server` failed with `EUNSUPPORTEDPROTOCOL`).
- Claude Code skill files added to `.claude/skills/` — six invocable skills: `/orca-generate`, `/orca-verify`, `/orca-compile`, `/orca-refine`, `/orca-actions`, `/orca-generate-multi`.

---

## [v0.1.0] — 2026-03-28

First public release. All core language features, three runtimes at feature parity, four demo applications, and the agent adoption layer are complete.

### Packages

| Package | npm / pip / Go |
|---------|---------------|
| `@orcalang/orca-lang` | `npm install @orcalang/orca-lang` |
| `@orcalang/orca-runtime-ts` | `npm install @orcalang/orca-runtime-ts` |
| `@orcalang/orca-mcp-server` | `npm install @orcalang/orca-mcp-server` |
| `orca-runtime-python` | `pip install orca-runtime-python` |
| `orca-runtime-go` | `go get github.com/jascal/orca-lang/packages/runtime-go` |

### Language (packages/orca-lang)

- **Parser**: two-phase markdown parser for `.orca.md` format — headings, tables, bullet lists, blockquotes. Auto-detects legacy `.orca` DSL files for backward compatibility
- **Verifier**: four-pass static analysis — structural (reachability, deadlocks, orphans), completeness (every state handles every event), determinism (mutually exclusive guards), property checking (bounded model checking with BFS: reachable, unreachable, passes_through, live, responds, invariant)
- **Cross-machine verifier**: cycle detection, machine resolution, child reachability, `on_done`/`on_error` event validation, combined state budget
- **Compilers**: XState v5 `createMachine()` config (TypeScript), Mermaid `stateDiagram-v2`
- **`## effects` section**: declared effect types with input/output schemas; `ORPHAN_EFFECT` and `UNDECLARED_EFFECT` verifier warnings
- **Machine invocation**: `invoke:` / `on_done:` / `on_error:` bullet syntax; single-file multi-machine with `---` separators
- **CLI**: `orca verify`, `orca compile xstate|mermaid`, `orca visualize`, `orca actions`, `orca convert` (legacy DSL → markdown), `orca --tools --json`, `--stdin` on all commands
- **Skills** (LLM-friendly structured JSON commands): `/parse-machine`, `/verify-orca`, `/compile-orca`, `/generate-orca`, `/generate-orca-multi`, `/generate-actions`, `/refine-orca`
- **LLM integration**: Anthropic, OpenAI-compatible, Ollama providers; `generate_machine` and `refine_machine` loop to convergence (up to `max_iterations`)
- **Auth**: OAuth device-code flow for Anthropic; API key via env or `.orca.env`
- **Error catalog**: 29 verifier codes documented in `docs/error-catalog.md`

### MCP Server (packages/mcp-server)

- MCP stdio server exposing 7 tools: `parse_machine`, `verify_machine`, `compile_machine`, `generate_machine`, `generate_multi_machine`, `generate_actions`, `refine_machine`
- All tools accept `source: string` — no files required
- JSON schemas on all inputs; compatible with Claude Desktop, any MCP host

### TypeScript Runtime (packages/runtime-ts)

- `parseOrcaAuto` — format auto-detection (`.orca.md` markdown or legacy DSL)
- `OrcaMachine` — event bus, state transitions, guard evaluation, action execution, timeout transitions, parallel regions (all-final / any-final sync), hierarchical states, child machine lifecycle
- `OrcaMachine.resume()` — cold-boot from snapshot without re-running `on_entry`
- `PersistenceAdapter` + `FilePersistence` — atomic JSONL snapshot save/load
- `LogSink` + `FileSink` / `ConsoleSink` / `MultiSink` / `makeEntry()` — structured JSONL audit logging
- `## effects` parsing + `EffectDef` type

### Python Runtime (packages/runtime-python)

- Feature parity with TypeScript runtime
- `parse_orca_auto`, `OrcaMachine`, decorator-style action and effect handler registration
- `OrcaMachine.resume()`, `FilePersistence`, `FileSink` / `ConsoleSink` / `MultiSink`

### Go Runtime (packages/runtime-go)

- Feature parity with TypeScript and Python runtimes
- Goroutine-based event bus, `OrcaMachine` struct, guard evaluation, action registration, timeout management, parallel regions, snapshot/restore
- `OrcaMachine.Resume()`, `FilePersistence`, `FileSink` / `ConsoleSink` / `MultiSink` / `MakeEntry()`
- Module path: `github.com/jascal/orca-lang/packages/runtime-go`
- 16 tests

### Demo Applications

- **demo-ts**: Playable text adventure game — 8-state machine, 4 locations, inventory, score, LLM narrative generation, `MultiSink` audit logging, `FilePersistence` snapshots
- **demo-python**: Agent framework — order processing (8-state workflow), multi-agent task orchestration, event bus request/response patterns
- **demo-go**: Ride-hailing trip coordinator — 5-machine `trip.orca.md` (TripCoordinator, DriverDispatch, PaymentAuth, TripExecution, FareSettlement); runs FareSettlement end-to-end with logging and persistence
- **demo-nanolab**: nanoGPT training orchestrator — 5-machine architecture (TrainingLab, DataPipeline, HyperSearch with parallel regions, TrainingRun, Evaluator); pluggable persistence, structured JSONL audit logging, rich terminal display, LLM workflow refinement via `--refine`; 47 tests (no torch required)

### Documentation

- `AGENTS.md` — agent integration guide: installation, generation loop, LLM auth, stdin/source string patterns, multi-machine workflows, runtime extension examples (TypeScript, Python, Go)
- `docs/error-catalog.md` — all 29 verifier error codes with severity, cause, fix, and examples
- `docs/phase-5-agent-adoption.md` — Phase 6 design document
- `docs/demo-ride-hailing.md` — Go demo design
- `docs/demo-nanolab.md` — nanolab demo design
- `docs/machine-invocation-design.md` — machine invocation design

### Test Counts

| Package | Tests |
|---------|-------|
| orca-lang | 135 |
| runtime-ts | 63 |
| runtime-python | 69 |
| runtime-go | 16 |
| demo-nanolab | 47 |

---

[v0.1.0]: https://github.com/jascal/orca-lang/releases/tag/v0.1.0
