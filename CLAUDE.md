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
  runtime-go/      (planned) Go runtime: goroutine-based event bus, OrcaMachine, effect handlers
  demo-ts/         Text adventure game demo (uses runtime-ts)
  demo-python/     Agent framework demo (uses runtime-python)
  demo-go/         (planned) Ride-hailing trip coordinator demo (uses runtime-go)
```

## Setup

```bash
# TypeScript packages (from repo root)
pnpm install

# Python packages (from repo root)
python3 -m venv .venv
.venv/bin/pip install -e packages/runtime-python
.venv/bin/pip install -e packages/demo-python
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
.venv/bin/python packages/demo-python/demo.py

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
Standalone TypeScript runtime (not XState-dependent). Event bus with pub/sub and request/response, OrcaMachine class, effect router, markdown parser with auto-detection.

### packages/runtime-python (orca-runtime-python)
Standalone Python async runtime. Zero external dependencies. Async event bus, OrcaMachine, effect handlers with decorator API, markdown parser with auto-detection.

### packages/demo-ts (orca-demo-ts)
Playable text adventure game. Interactive CLI, 8-state machine, world map with 4 locations, inventory system, score tracking, LLM narrative generation path. Depends on `@orca-lang/orca-runtime-ts` via pnpm workspace.

### packages/demo-python (orca-demo-python)
Agent framework demo with 4 scenarios: order processing (8-state workflow), multi-agent task orchestration, event bus request/response, and parsed Orca machine.

## Cross-Package Dependencies

```
demo-ts      ──depends on──>  runtime-ts      (pnpm workspace:*)
demo-python  ──depends on──>  runtime-python  (pip install -e, declared in pyproject.toml)
demo-go      ──depends on──>  runtime-go      (go module dependency)
```

The orca-lang package is independent — runtimes implement their own parsers and can operate without it.

## Implementation Roadmap

See `packages/orca-lang/CLAUDE.md` for detailed per-phase status.

**Phase 3.5 Complete**: Markdown syntax migration — `.orca.md` format with tables, headings, and bullet lists. Auto-detection selects the appropriate parser. All runtimes support markdown format. 137 orca-lang tests (26 markdown parser), 63 runtime-ts tests, 72 runtime-python tests (8 markdown parser). Skill prompts updated for markdown generation.

**Phase 4 Complete**: Machine invocation — state machines calling other state machines. `InvokeDef` on `StateDef`, single-file multi-machine with `---` separators, cross-machine verifier (cycle detection, child reachability, machine resolution), XState invoke config (`__machine__:Name`), runtime-ts and runtime-python child lifecycle (start on entry, stop on exit, completion events, snapshot/restore). 128 orca-lang tests, 63 runtime-ts tests, 68 runtime-python tests.

**Next major milestone — Phase 4.5: Go Runtime + Ride-Hailing Demo** — `runtime-go` package to feature parity with TS/Python runtimes (including machine invocation), then a 5-machine ride-hailing trip coordinator demo built in Go. Design doc: `docs/demo-ride-hailing.md`.

## Known Limitations (v1 parallel regions)
- `any-final` sync strategy has no native XState equivalent — works in standalone runtimes only
- Nested parallel (parallel inside a region) is disallowed for v1
- Mermaid parallel rendering depends on renderer support for `--` syntax in `stateDiagram-v2`
