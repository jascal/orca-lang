# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Orca (Orchestrated State Machine Language)** - A two-layer architecture for LLM code generation that separates program topology (state machine structure) from computation (action functions).

This is a **pnpm monorepo** containing the core language, runtimes (TypeScript, Python, Go, and Rust), and demo applications.

## Monorepo Structure

```
packages/
  orca-lang/       Core language: parser, verifier, XState/Mermaid compiler, CLI
  runtime-ts/      TypeScript async runtime: event bus, OrcaMachine, effect router
  runtime-python/  Python async runtime: event bus, OrcaMachine, effect handlers
  runtime-go/      Go runtime: goroutine-based event bus, OrcaMachine, effect handlers
  runtime-rust/    Rust runtime with C FFI: parser, verifier, executor, C ABI surface
  demo-ts/         Text adventure game demo (uses runtime-ts)
  demo-python/     Agent framework demo (uses runtime-python)
  demo-go/         Ride-hailing trip coordinator demo (uses runtime-go)
  demo-fortran/    N-agent market simulation (Fortran FFI to runtime-rust)
  demo-nanolab/    nanoGPT training orchestrator demo (uses runtime-python)
```

## Setup

```bash
# TypeScript packages (from repo root)
pnpm install

# Python packages — auto-detects Python >= 3.10 (installs runtime, demo, nanolab)
pnpm run setup:python

# Go packages (from repo root)
pnpm run setup:go
pnpm run build:demo-go

# Rust runtime (from repo root)
pnpm run setup:rust

# Fortran demo (requires gfortran)
pnpm run build:demo-fortran
```

## Commands

```bash
# Build all TypeScript packages
pnpm build

# Run all tests (TypeScript)
pnpm test

# Run only orca-lang tests
pnpm test:lang

# Run demo-ts smoke test
pnpm test:demo-ts

# Run TypeScript demos
pnpm run run:demo-ts           # Interactive text adventure game
pnpm run run:demo-ts:ticket    # Support Ticket Escalation (Decision Table demo)

# Run Python demo
pnpm run test:demo-python

# Run Go demos
pnpm run test:demo-go          # Ride-hailing trip coordinator
pnpm run run:demo-go:loan      # Loan Application Processor (Decision Table demo)

# Run Rust runtime tests
pnpm run test:rust

# Run Fortran demo (requires gfortran)
pnpm run test:demo-fortran

# Run nanolab demo tests (machine parsing + pipeline logic, no torch required)
pnpm run test:demo-nanolab

# Run nanolab demo pipeline (requires torch for actual training)
pnpm run run:demo-nanolab

# Dogfood health check — runs all builds, tests, and demos sequentially
pnpm health-check

# CLI commands (from packages/orca-lang)
cd packages/orca-lang
npx tsx src/index.ts verify examples/simple-toggle.orca.md
npx tsx src/index.ts compile xstate examples/payment-processor.orca.md
npx tsx src/index.ts compile mermaid examples/text-adventure.orca.md
```

## Package Details

### packages/orca-lang (core)
The core language package. See `packages/orca-lang/CLAUDE.md` for detailed architecture, source organization, verifier details, and implementation status.

- **Parser**: two-phase markdown parser for `.orca.md` format (lexer + parser + AST) with format auto-detection
- **Verifiers**: structural (reachability, deadlocks), completeness, determinism, property checking (bounded model checking)
- **Compilers**: XState v5 config + string output, Mermaid stateDiagram-v2
- **Converter**: `orca convert` — migrates legacy `.orca` files to `.orca.md` with round-trip verification
- **Runtime**: XState-based effect runtime with handler registry
- **LLM integration**: Anthropic, OpenAI, Grok, Ollama providers
- **CLI skills**: `/generate-orca`, `/verify-orca`, `/compile-orca`, `/generate-actions`, `/refine-orca`

### packages/runtime-ts (@orcalang/orca-runtime-ts)
Standalone TypeScript runtime (not XState-dependent). Event bus with pub/sub and request/response, OrcaMachine class, effect router, markdown parser with auto-detection. Features: `## effects` section parsing (`EffectDef`), `OrcaMachine.resume()` (cold-boot from snapshot), `PersistenceAdapter` + `FilePersistence` (atomic JSONL), `LogSink` + `FileSink`/`ConsoleSink`/`MultiSink`/`makeEntry()`.

### packages/runtime-python (orca-runtime-python)
Standalone Python async runtime. Zero external dependencies. Async event bus, OrcaMachine, effect handlers with decorator API, markdown parser with auto-detection. Features: `## effects` section parsing (`EffectDef`), `OrcaMachine.resume()`, `PersistenceAdapter` + `FilePersistence`, `LogSink` + `FileSink`/`ConsoleSink`/`MultiSink`/`make_entry()`.

### packages/runtime-go (orca-runtime-go)
Standalone Go runtime. Zero external dependencies. Goroutine-based event bus, OrcaMachine struct, guard evaluation, action registration, timeout management, snapshot/restore, machine invocation parsing. Features: `## effects` section parsing (`EffectDef`), `OrcaMachine.Resume()`, `PersistenceAdapter` + `FilePersistence`, `LogSink` + `FileSink`/`ConsoleSink`/`MultiSink`/`MakeEntry()`. 16 tests.

### packages/runtime-rust (orca-runtime-rust)
Rust runtime with C-compatible FFI surface. Markdown parser (two-phase: structural → semantic), basic verifier (initial state, reachability, deadlock), synchronous state machine executor with guard evaluation and action dispatch via C function pointers. Produces `.dylib`/`.so`/`.a` for linking from C/Fortran callers. JSON-based event/state serialization over `const char*`. 29 tests.

### packages/demo-fortran
N-agent market simulation. 80 concurrent state machine agents (20 Producer, 50 Consumer, 10 Speculator) driven by a Fortran tick loop via Orca's C FFI. Fortran owns the scheduler — sends ticks, waits for completion, computes market price, broadcasts price signals. Emergent macro behavior (price equilibrium, speculative bubbles) from simple local rules. Requires `gfortran` and links against `runtime-rust`.

### packages/demo-ts (orca-demo-ts)
Playable text adventure game. Interactive CLI, 8-state machine, world map with 4 locations, inventory system, score tracking, LLM narrative generation path. Showcases `## effects` parsing, `MultiSink` audit logging, `FilePersistence` snapshot/checkpoint, and `OrcaMachine.resume()`. Depends on `@orcalang/orca-runtime-ts` via pnpm workspace.

Also includes: **Support Ticket Escalation** demo (`pnpm run run:demo-ts:ticket`) — 8-state workflow with two decision tables (triaging + routing), demonstrating multiple DTs per workflow.

### packages/demo-python (orca-demo-python)
Agent framework demo with 6 scenarios: order processing (8-state workflow), multi-agent task orchestration, event bus request/response, parsed Orca machine, Decision Table evaluator, and Order Fulfillment with DT routing.

### packages/demo-go (orca-demo-go)
Ride-hailing trip coordinator demo. 5-machine `trip.orca.md` (TripCoordinator, DriverDispatch, PaymentAuth, TripExecution, FareSettlement). Runs FareSettlement end-to-end showcasing `## effects` display, `MultiSink` JSONL audit logging, `FilePersistence` checkpoint, and `--resume` flag via `OrcaMachine.Resume()`.

Also includes: **Loan Application Processor** demo (`pnpm run run:demo-go:loan`) — 6-state workflow with two formal decision tables (risk assessment + disbursement), demonstrating `int_range` and `decimal_range` numeric conditions with comparison operators and range expressions.

### packages/demo-nanolab (orca-demo-nanolab)
nanoGPT training orchestrator. 5-machine architecture in a single `.orca.md` file (separated by `---`): TrainingLab (coordinator), DataPipeline, HyperSearch (parallel trial regions), TrainingRun, Evaluator. Recursive multi-machine driver with context merging and parallel dispatch via `asyncio.gather`. Vendors nanoGPT's `train.py`/`model.py`/`sample.py`. Features: pluggable persistence (`FilePersistence`, `--persist`), structured JSONL audit logging (`FileSink`, `--log`), rich terminal display, LLM workflow refinement (`--refine`). Requires `torch` for actual training; 47 tests run without it. Design doc: `docs/demo-nanolab.md`.

## Cross-Package Dependencies

```
demo-ts      ──depends on──>  runtime-ts      (pnpm workspace:*)
demo-python  ──depends on──>  runtime-python  (pip install -e, declared in pyproject.toml)
demo-go      ──depends on──>  runtime-go      (go module dependency)
demo-nanolab ──depends on──>  runtime-python  (pip install -e, declared in pyproject.toml)
demo-fortran ──depends on──>  runtime-rust    (Makefile links against liborca_runtime_rust)
```

The orca-lang package is independent — runtimes implement their own parsers and can operate without it.

## Implementation Roadmap

See `packages/orca-lang/CLAUDE.md` for detailed per-phase status.

**Phase 3.5 Complete**: Markdown syntax migration — `.orca.md` format with tables, headings, and bullet lists. Auto-detection selects the appropriate parser. All runtimes support markdown format. Skill prompts updated for markdown generation.

**Phase 4 Complete**: Machine invocation — state machines calling other state machines. `InvokeDef` on `StateDef`, single-file multi-machine with `---` separators, cross-machine verifier (cycle detection, child reachability, machine resolution), XState invoke config (`__machine__:Name`), runtime-ts and runtime-python child lifecycle (start on entry, stop on exit, completion events, snapshot/restore).

**Phase 4.5 Complete**: Go runtime + feature parity across all runtimes.
- `runtime-go`: core machine, guards, actions, event bus, timeouts, parallel regions, snapshot/restore, invoke parsing — 16 tests
- `demo-go`: 5-machine `trip.orca.md` (TripCoordinator, DriverDispatch, PaymentAuth, TripExecution, FareSettlement); runs FareSettlement end-to-end with logging + persistence
- Feature parity ported from runtime-python to runtime-ts and runtime-go: `## effects` section parsing (`EffectDef`), `OrcaMachine.resume()` / `Resume()`, `PersistenceAdapter` + `FilePersistence`, `LogSink` + `FileSink`/`ConsoleSink`/`MultiSink`/`makeEntry()`
- Core language: `## effects` parsing in markdown parser, `EffectDef` in AST, round-trip in ast-to-markdown, `ORPHAN_EFFECT` + `UNDECLARED_EFFECT` verifier warnings, `Effect` column support in actions table
- Design doc: `docs/demo-ride-hailing.md`
- **Test counts**: 135 orca-lang tests, 63 runtime-ts tests, 69 runtime-python tests, 16 runtime-go tests, 29 runtime-rust tests, 47 demo-nanolab tests

**Phase 5 (nanolab) Complete**: demo-nanolab — all 8 phases shipped. 5-machine orchestrator (TrainingLab, DataPipeline, HyperSearch with parallel regions, TrainingRun, Evaluator). Framework features driven by this demo: `## effects` section in Python parser (`EffectDef`), pluggable `PersistenceAdapter` + `FilePersistence` + `OrcaMachine.resume()`, `LogSink` protocol + `FileSink`/`ConsoleSink`/`MultiSink`. Rich terminal display (Phase 7). LLM workflow refinement via Claude API (Phase 8 — `nanolab.refine`, `--refine` flag). 47 tests (no torch required). Design doc: `docs/demo-nanolab.md`.

**Decision Table Demos Complete**: Three DT demo ideas implemented across runtimes:
- **demo-python Order Fulfillment** (`pnpm run test:demo-python`): 6-state workflow + DT at `routed` state for shipping/warehouse/fraud routing — demonstrates SM + DT for conditional routing
- **demo-ts Support Ticket Escalation** (`pnpm run run:demo-ts:ticket`): 8-state workflow + 2 DTs (triaging + routing) — demonstrates multiple DTs per workflow, first-match policy
- **demo-go Loan Application Processor** (`pnpm run run:demo-go:loan`): 6-state workflow + 2 DTs (risk assessment + disbursement) — demonstrates `int_range` numeric conditions, enum conditions, bool conditions

**Phase 4.6 — Rust Runtime + Fortran FFI** ✅ Complete: Rust-based Orca runtime with C-compatible FFI, enabling Fortran callers to instantiate and drive state machines.
- `runtime-rust/`: Markdown parser (two-phase), basic verifier, synchronous executor, guard evaluation, C function pointer action callbacks, full FFI surface (`orca_init`, `orca_send`, `orca_wait`, `orca_state`, `orca_register_action`, etc.). 29 tests.
- `demo-fortran/`: 80-agent market simulation (20 Producer, 50 Consumer, 10 Speculator). Fortran owns the tick loop, Rust handles state machines. 100-tick simulation with emergent price dynamics. Requires `gfortran`.
- Design doc: `docs/runtime-rust-fortran.md`

**Dogfood Health Check**: Orca dogfoods itself via `pnpm health-check` — runs all builds, tests, and demos sequentially (~22s). State machine definition at `packages/orca-lang/examples/health-check.orca.md`, TypeScript runner at `packages/orca-lang/src/health-check.ts`.

**Phase 6 — Agent Adoption & Distribution** ⏳ Not started: Make Orca installable and usable by external agent systems (OpenClaw, AutoGen, Claude tool use, etc.) without cloning the repo or writing files to disk. Three tracks:
- **Track A — Distribution**: publish npm/PyPI/Go packages, fix Go module path, GitHub Actions release workflow, CHANGELOG
- **Track B — MCP Server**: `packages/mcp-server` exposing all skills as MCP tools with JSON schemas; stdin support on CLI; `orca --tools --json` self-description
- **Track C — Skill Completeness**: refactor skills to accept `source` strings (not just file paths), `/parse-machine` (AST as JSON), `/generate-actions` for Python + Go, `/generate-orca-multi` (multi-machine from one spec), looping `/refine-orca`, error catalog, `AGENTS.md` integration guide
- Design doc: `docs/phase-5-agent-adoption.md`

**Future: DT-Aware Machine Verification** ⏳ Not started: When a decision table is co-located and fully aligned with a machine, its deterministic nature unlocks deeper machine-level verification. Currently shipped: `DT_COVERAGE_GAP` (DT must handle all machine-context input combinations) and `DT_GUARD_DEAD` (guards on DT output fields must compare against values the DT can actually produce). Two further checks are out of scope for now:
- **Dead-guard reachability propagation**: `structural.ts` reachability BFS currently ignores guards. After `DT_GUARD_DEAD` identifies dead guards, thread those dead guard names into the BFS so that transitions protected by them are pruned — surfacing `STRUCTURAL_UNREACHABLE` states that are graph-reachable but semantically unreachable given DT outputs.
- **Properties model checker precision**: `properties.ts` BFS treats every guard-protected transition as potentially fireable because action postconditions are opaque. With an aligned DT, the context values after a DT-backed action are fully known. This enables: (1) more precise `reachable`/`responds` property checking along DT-constrained paths; (2) `invariant` assertions checked against DT output domains rather than just state-local values. In effect, co-located DTs turn the property checker from a structural tool into a lightweight concrete model checker.

**Numeric Range Conditions in Decision Tables** ✅ Complete: Full numeric range support across the DT pipeline. The loan demo (`demo-go/orca/loan-workflow.orca.md`) now uses formal `# decision_table` sections with `int_range` and `decimal_range` condition types.
- **`dt-ast.ts`**: `CellValue` extended with `compare` (op + value) and `range` (low/high + inclusive flags) kinds. `decimal_range` added to `ConditionType`.
- **`dt-parser.ts`**: `parseCellValue` recognizes `750+`, `>=750`, `<600`, `700..749`, `0.3-0.4` patterns for `int_range`/`decimal_range` columns. Enum columns still treat these as exact strings.
- **`dt-verifier.ts`**: `cellMatches` handles numeric comparisons; `cellsIntersect` uses interval overlap detection; completeness uses interval arithmetic (union of rule intervals checked against declared domain) with integer adjacency for `int_range`. `DT_COMPLETENESS_SKIPPED` only when no domain range is declared.
- **`dt-compiler.ts`**: Emits `>=`/`<=`/`<`/`>` and range comparisons in generated TypeScript, Python, and Go code.

## Known Limitations (v1 parallel regions)
- `any-final` sync strategy has no native XState equivalent — works in standalone runtimes only
- Nested parallel (parallel inside a region) is disallowed for v1
- Mermaid parallel rendering depends on renderer support for `--` syntax in `stateDiagram-v2`

## Known Limitations (completeness / ignore syntax)
- `- ignore: EVENT` and `- ignore: *` are misleading names: they read as "this state ignores these events entirely" but the actual semantic is "use discard-as-default for events that arrive in this state with no matching transition." Transitions always take precedence; ignore is a fallback policy, not an override. A clearer syntax would be `- unhandled: discard` or a machine-level `## ignore_policy: implicit` declaration. This is a pre-existing naming issue in the language spec — not introduced by the `ignore: *` wildcard extension.
