# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Orca (Orchestrated State Machine Language)** - A two-layer architecture for LLM code generation that separates program topology (state machine structure) from computation (action functions).

This is a **pnpm monorepo** containing the core language, runtimes (TypeScript, Python, and planned Go), and demo applications.

## Monorepo Structure

```
packages/
  orca-lang/       Core language: parser, verifier, XState/Mermaid compiler, CLI
  runtime-ts/      TypeScript async runtime: event bus, OrcaMachine, effect router
  runtime-python/  Python async runtime: event bus, OrcaMachine, effect handlers
  runtime-go/      Go runtime: goroutine-based event bus, OrcaMachine, effect handlers
  demo-ts/         Text adventure game demo (uses runtime-ts)
  demo-python/     Agent framework demo (uses runtime-python)
  demo-go/         Ride-hailing trip coordinator demo (uses runtime-go)
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

# Run Python demo
pnpm run test:demo-python

# Run Go demo
pnpm run test:demo-go

# Run nanolab demo tests (machine parsing + pipeline logic, no torch required)
pnpm run test:demo-nanolab

# Run nanolab demo pipeline (requires torch for actual training)
pnpm run run:demo-nanolab

# Interactive text adventure
cd packages/demo-ts && pnpm run cli

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

### packages/runtime-ts (@orca-lang/orca-runtime-ts)
Standalone TypeScript runtime (not XState-dependent). Event bus with pub/sub and request/response, OrcaMachine class, effect router, markdown parser with auto-detection. Features: `## effects` section parsing (`EffectDef`), `OrcaMachine.resume()` (cold-boot from snapshot), `PersistenceAdapter` + `FilePersistence` (atomic JSONL), `LogSink` + `FileSink`/`ConsoleSink`/`MultiSink`/`makeEntry()`.

### packages/runtime-python (orca-runtime-python)
Standalone Python async runtime. Zero external dependencies. Async event bus, OrcaMachine, effect handlers with decorator API, markdown parser with auto-detection. Features: `## effects` section parsing (`EffectDef`), `OrcaMachine.resume()`, `PersistenceAdapter` + `FilePersistence`, `LogSink` + `FileSink`/`ConsoleSink`/`MultiSink`/`make_entry()`.

### packages/runtime-go (orca-runtime-go)
Standalone Go runtime. Zero external dependencies. Goroutine-based event bus, OrcaMachine struct, guard evaluation, action registration, timeout management, snapshot/restore, machine invocation parsing. Features: `## effects` section parsing (`EffectDef`), `OrcaMachine.Resume()`, `PersistenceAdapter` + `FilePersistence`, `LogSink` + `FileSink`/`ConsoleSink`/`MultiSink`/`MakeEntry()`. 16 tests.

### packages/demo-ts (orca-demo-ts)
Playable text adventure game. Interactive CLI, 8-state machine, world map with 4 locations, inventory system, score tracking, LLM narrative generation path. Showcases `## effects` parsing, `MultiSink` audit logging, `FilePersistence` snapshot/checkpoint, and `OrcaMachine.resume()`. Depends on `@orca-lang/orca-runtime-ts` via pnpm workspace.

### packages/demo-python (orca-demo-python)
Agent framework demo with 4 scenarios: order processing (8-state workflow), multi-agent task orchestration, event bus request/response, and parsed Orca machine.

### packages/demo-go (orca-demo-go)
Ride-hailing trip coordinator demo. 5-machine `trip.orca.md` (TripCoordinator, DriverDispatch, PaymentAuth, TripExecution, FareSettlement). Runs FareSettlement end-to-end showcasing `## effects` display, `MultiSink` JSONL audit logging, `FilePersistence` checkpoint, and `--resume` flag via `OrcaMachine.Resume()`.

### packages/demo-nanolab (orca-demo-nanolab)
nanoGPT training orchestrator. 5-machine architecture in a single `.orca.md` file (separated by `---`): TrainingLab (coordinator), DataPipeline, HyperSearch (parallel trial regions), TrainingRun, Evaluator. Recursive multi-machine driver with context merging and parallel dispatch via `asyncio.gather`. Vendors nanoGPT's `train.py`/`model.py`/`sample.py`. Features: pluggable persistence (`FilePersistence`, `--persist`), structured JSONL audit logging (`FileSink`, `--log`), rich terminal display, LLM workflow refinement (`--refine`). Requires `torch` for actual training; 47 tests run without it. Design doc: `docs/demo-nanolab.md`.

## Cross-Package Dependencies

```
demo-ts      ──depends on──>  runtime-ts      (pnpm workspace:*)
demo-python  ──depends on──>  runtime-python  (pip install -e, declared in pyproject.toml)
demo-go      ──depends on──>  runtime-go      (go module dependency)
demo-nanolab ──depends on──>  runtime-python  (pip install -e, declared in pyproject.toml)
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
- **Test counts**: 135 orca-lang tests, 63 runtime-ts tests, 69 runtime-python tests, 16 runtime-go tests, 47 demo-nanolab tests

**Phase 5 (nanolab) Complete**: demo-nanolab — all 8 phases shipped. 5-machine orchestrator (TrainingLab, DataPipeline, HyperSearch with parallel regions, TrainingRun, Evaluator). Framework features driven by this demo: `## effects` section in Python parser (`EffectDef`), pluggable `PersistenceAdapter` + `FilePersistence` + `OrcaMachine.resume()`, `LogSink` protocol + `FileSink`/`ConsoleSink`/`MultiSink`. Rich terminal display (Phase 7). LLM workflow refinement via Claude API (Phase 8 — `nanolab.refine`, `--refine` flag). 47 tests (no torch required). Design doc: `docs/demo-nanolab.md`.

## Known Limitations (v1 parallel regions)
- `any-final` sync strategy has no native XState equivalent — works in standalone runtimes only
- Nested parallel (parallel inside a region) is disallowed for v1
- Mermaid parallel rendering depends on renderer support for `--` syntax in `stateDiagram-v2`
