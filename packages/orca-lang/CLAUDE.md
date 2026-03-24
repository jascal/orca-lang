# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Orca (Orchestrated State Machine Language)** - A two-layer architecture for LLM code generation that separates program topology (state machine structure) from computation (action functions).

The core insight: LLMs generate flat transition tables reliably, but topology verification ensures correctness that LLMs struggle to guarantee on their own.

## Commands

```bash
# Build TypeScript to dist/
npm run build

# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run a specific test file
npx vitest run tests/parser.test.ts

# CLI commands (requires build or use tsx)
npx tsx src/index.ts verify examples/simple-toggle.orca
npx tsx src/index.ts compile xstate examples/payment-processor.orca
npx tsx src/index.ts compile mermaid examples/text-adventure.orca
npx tsx src/index.ts visualize examples/simple-toggle.orca
```

## Architecture

### Pipeline Flow
```
Source (.orca) → Lexer → Parser → AST → Verifier → Compiler → Output (XState/Mermaid)
```

### Runtime Architecture

Orca is designed to be **runtime-agnostic** - the core language, parser, and verifier are shared across all targets. Specific runtime implementations are provided as separate packages for projects that don't already have their own event/state machine infrastructure.

**Core (`packages/orca-lang` — this package)**
- Language definition, parser, AST types
- Verification (structural, completeness, determinism)
- Compilation to target formats (XState v5, Mermaid)
- XState-specific runtime scaffolding (`src/runtime/`) for TypeScript projects using XState

**Runtime Packages** (sibling packages in this monorepo)

| Package | Path | Language | Status |
|---------|------|----------|--------|
| `orca-runtime-python` | `packages/runtime-python` | Python | Functional — async event bus, state machine runtime, effect handlers, DSL parser |
| `@orca-lang/orca-runtime-ts` | `packages/runtime-ts` | TypeScript | Functional — event bus, OrcaMachine, effect router, DSL parser (not XState-dependent) |

**Demo Applications** (sibling packages in this monorepo)

| Demo | Path | Description |
|------|------|-------------|
| `orca-demo-ts` | `packages/demo-ts` | Playable text adventure game — interactive CLI, 8-state machine, world map, inventory, LLM narrative |
| `orca-demo-python` | `packages/demo-python` | Agent framework demo — order processing, multi-agent orchestration, event bus patterns |

**Design Principles for Runtime Packages**
- Each runtime is standalone - it can execute Orca machines without requiring Orca core
- Runtimes implement similar `EventBus` interfaces (publish/subscribe, request/response)
- Each runtime may have different effect handler semantics appropriate to its environment
- Machines can be compiled once and deployed to any runtime that supports Orca
- Runtimes are for projects starting fresh - projects with existing state machine infra can use Orca's compilers directly

**Importing Across Runtimes**
```
# Python runtime
from orca_runtime_python import parse_orca, OrcaMachine

# TypeScript runtime
import { parseOrca, OrcaMachine } from '@orca-lang/orca-runtime-ts'
```

**Known Shared Gaps in Both Runtimes**
- Guard evaluation for complex expressions (`compare`, `and`, `or`, `not`, `nullcheck`) is stubbed — always returns true
- Plain (non-effect) action execution is a no-op — only effect-based actions trigger handlers
- Timeout transitions are parsed but not enforced at runtime
- Test coverage is minimal in both runtimes

### Source Organization
- **src/parser/ast.ts** - AST type definitions shared across all modules
- **src/parser/lexer.ts** - Tokenizer; keywords become TokenType enums
- **src/parser/parser.ts** - Hand-written recursive descent parser; handles SMGL syntax
- **src/verifier/structural.ts** - Reachability, deadlock, orphan detection; `analyzeMachine()` builds the `MachineAnalysis` object
- **src/verifier/completeness.ts** - Checks every (state, event) pair is handled or explicitly ignored
- **src/verifier/determinism.ts** - Checks guards on multi-transition pairs are mutually exclusive
- **src/compiler/xstate.ts** - Compiles AST to XState v5 `createMachine()` config
- **src/compiler/mermaid.ts** - Compiles AST to Mermaid `stateDiagram-v2`
- **src/runtime/effects.ts** - Effect routing types (Phase 2.7 complete - XState scaffolding)

### Key Design Decisions

1. **Hand-written parser** - Grammar is simple; custom parser gives good error messages
2. **Verifier analyzes `MachineAnalysis`** - Built once by `analyzeMachine()`, consumed by all checkers
3. **XState guarded transitions** - Use array format when multiple transitions exist for same event: `[{ target: 's1', guard: 'cond1' }, { target: 's2', guard: '!cond1' }]`
4. **State references in XState** - Guarded transitions use `#state` syntax to reference compound transitions
5. **Runtime-agnostic core** - Orca compiles to target formats (XState/Mermaid) but does not mandate a specific runtime

### Implementation Status

| Phase | Status | Description |
|-------|--------|-------------|
| Phase 1 | ✅ Complete | Core language, parser, verifier, XState/Mermaid compilation |
| Phase 2 | ✅ Complete | LLM integration, prompt templates, action generation |
| Phase 2.5 | ✅ Complete | CLI skills (`/generate-orca`, `/verify-orca`, etc.) |
| Phase 2.7 | ✅ Functional | Both runtimes work (`orca-runtime-python`, `orca-runtime-ts`) — guards and plain actions stubbed |
| Phase 2.8 | ✅ Complete | Two demos: `orca-demo-ts` (text adventure) and `orca-demo-python` (agent framework) |
| Phase 3 | ✅ Partial | Hierarchical states complete in `orca-lang`; parallel regions not yet implemented |
| Phase 4 | ⏳ Not started | Ecosystem (package registry, visual editor, fine-tuning, multi-machine composition) |

**Phase 2.7 detail — what "functional" means:**
- Event bus (pub/sub, request/response), OrcaMachine, effect routing, DSL parsers all work
- Guard evaluation for complex expressions is stubbed (always returns true) in both runtimes
- Non-effect action execution is a no-op in both runtimes
- Timeout transitions parsed but not enforced
- `machine.restore()` not implemented in orca-lang XState runtime

**Phase 3 detail — what's done vs pending:**
- ✅ Hierarchical (nested) states — parser, verifier (flattening + compound state handling), XState compilation
- ⏳ Parallel regions — `PARALLEL`/`REGION` keywords in lexer/AST only, no implementation
- ⏳ Property specification / bounded model checking
- ⏳ Additional compilation targets (Python, C, Lean)
- ⏳ IDE integration

### Skills (LLM-friendly CLI commands)

```bash
orca /generate-orca "A payment processor with retries"
orca /verify-orca examples/payment-processor.orca
orca /compile-orca xstate examples/payment-processor.orca
orca /generate-actions --use-llm examples/payment-processor.orca typescript
orca /refine-orca examples/payment-processor.orca
```

### File Extension
- Source files use `.orca` extension
- The lexer/parser don't enforce extension - they just process text

### Examples
- `examples/simple-toggle.orca` - Minimal 2-state machine for quick testing
- `examples/payment-processor.orca` - Full payment flow with guards and effects
- `examples/text-adventure.orca` - Game engine with multiple states and guards
- `examples/hierarchical-game.orca` - Hierarchical states: compound exploration/combat/inventory with nested children
