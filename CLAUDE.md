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

### Source Organization
- **src/parser/ast.ts** - AST type definitions shared across all modules
- **src/parser/lexer.ts** - Tokenizer; keywords become TokenType enums
- **src/parser/parser.ts** - Hand-written recursive descent parser; handles SMGL syntax
- **src/verifier/structural.ts** - Reachability, deadlock, orphan detection; `analyzeMachine()` builds the `MachineAnalysis` object
- **src/verifier/completeness.ts** - Checks every (state, event) pair is handled or explicitly ignored
- **src/verifier/determinism.ts** - Checks guards on multi-transition pairs are mutually exclusive
- **src/compiler/xstate.ts** - Compiles AST to XState v5 `createMachine()` config
- **src/compiler/mermaid.ts** - Compiles AST to Mermaid `stateDiagram-v2`
- **src/runtime/effects.ts** - Effect routing types (Phase 2.7 implementation pending)

### Key Design Decisions

1. **Hand-written parser** - Grammar is simple; custom parser gives good error messages
2. **Verifier analyzes `MachineAnalysis`** - Built once by `analyzeMachine()`, consumed by all checkers
3. **XState guarded transitions** - Use array format when multiple transitions exist for same event: `[{ target: 's1', guard: 'cond1' }, { target: 's2', guard: '!cond1' }]`
4. **State references in XState** - Guarded transitions use `#state` syntax to reference compound transitions
5. **No execution runtime yet** - Orca compiles to XState/Mermaid but doesn't run machines directly

### Implementation Status

| Phase | Status | Description |
|-------|--------|-------------|
| Phase 1 | ✅ Complete | Core language, parser, verifier, XState/Mermaid compilation |
| Phase 2 | ✅ Complete | LLM integration, prompt templates, action generation |
| Phase 2.5 | ✅ Complete | CLI skills (`/generate-orca`, `/verify-orca`, etc.) |
| Phase 2.7 | ⏳ Pending | Effect runtime for actual machine execution |
| Phase 2.8 | ⏳ Pending | Real-world demo (retro-quest text adventure) |
| Phase 3 | ⏳ Pending | Advanced features (hierarchical states, formal verification) |

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
