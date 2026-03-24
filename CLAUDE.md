# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Orca (Orchestrated State Machine Language)** - A two-layer architecture for LLM code generation that separates program topology (state machine structure) from computation (action functions).

This is a **pnpm monorepo** containing the core language, two runtimes (TypeScript and Python), and two demo applications.

## Monorepo Structure

```
packages/
  orca-lang/       Core language: parser, verifier, XState/Mermaid compiler, CLI
  runtime-ts/      TypeScript async runtime: event bus, OrcaMachine, effect router
  runtime-python/  Python async runtime: event bus, OrcaMachine, effect handlers
  demo-ts/         Text adventure game demo (uses runtime-ts)
  demo-python/     Agent framework demo (uses runtime-python)
```

## Commands

```bash
# Install all dependencies (from repo root)
pnpm install

# Build all TypeScript packages
pnpm build

# Run all tests
pnpm test

# Run only orca-lang tests
pnpm test:lang

# Run demo-ts smoke test
pnpm test:demo-ts

# Package-specific commands (from package directory)
cd packages/orca-lang && pnpm test
cd packages/demo-ts && pnpm run cli          # interactive text adventure
cd packages/demo-python && PYTHONPATH=../runtime-python python3 demo.py

# CLI commands (from packages/orca-lang)
cd packages/orca-lang
npx tsx src/index.ts verify examples/simple-toggle.orca
npx tsx src/index.ts compile xstate examples/payment-processor.orca
npx tsx src/index.ts compile mermaid examples/text-adventure.orca
```

## Package Details

### packages/orca-lang (core)
The core language package. See `packages/orca-lang/CLAUDE.md` for detailed architecture, source organization, verifier details, and implementation status.

- **Parser**: hand-written recursive descent (lexer + parser + AST)
- **Verifiers**: structural (reachability, deadlocks), completeness, determinism
- **Compilers**: XState v5 config + string output, Mermaid stateDiagram-v2
- **Runtime**: XState-based effect runtime with handler registry
- **LLM integration**: Anthropic, OpenAI, Grok, Ollama providers
- **CLI skills**: `/generate-orca`, `/verify-orca`, `/compile-orca`, `/generate-actions`, `/refine-orca`

### packages/runtime-ts (@orca-lang/orca-runtime-ts)
Standalone TypeScript runtime (not XState-dependent). Event bus with pub/sub and request/response, OrcaMachine class, effect router, Orca DSL parser.

### packages/runtime-python (orca-runtime-python)
Standalone Python async runtime. Zero external dependencies. Async event bus, OrcaMachine, effect handlers with decorator API, Orca DSL parser.

### packages/demo-ts (orca-demo-ts)
Playable text adventure game. Interactive CLI, 8-state machine, world map with 4 locations, inventory system, score tracking, LLM narrative generation path. Depends on `@orca-lang/orca-runtime-ts` via pnpm workspace.

### packages/demo-python (orca-demo-python)
Agent framework demo with 4 scenarios: order processing (8-state workflow), multi-agent task orchestration, event bus request/response, and parsed Orca machine.

## Cross-Package Dependencies

```
demo-ts  ──depends on──>  runtime-ts     (pnpm workspace:*)
demo-python  ──depends on──>  runtime-python  (pip editable / PYTHONPATH)
```

The orca-lang package is independent — runtimes implement their own parsers and can operate without it.

## Known Shared Gaps in Both Runtimes
- Guard evaluation for complex expressions (`compare`, `and`, `or`, `not`, `nullcheck`) is stubbed — always returns true
- Plain (non-effect) action execution is a no-op — only effect-based actions trigger handlers
- Timeout transitions are parsed but not enforced at runtime
- Test coverage is minimal in both runtimes
