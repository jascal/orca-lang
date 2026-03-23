# Orca Project Kickoff — Claude Code Prompt

## What This Is

You are starting implementation of **Orca (Orchestrated State Machine Language)**, a two-layer architecture designed as an LLM code generation target. The full design proposal is in:

```
docs/orca-proposal.md
```

**Read that file first before writing any code.** It contains the complete language specification, design rationale, verification pipeline, and implementation roadmap.

## Project Context

This project emerged from a long conversation about which programming languages are best suited as LLM code generation targets. The core insight is that **separating program topology (the state machine) from computation (individual actions)** enables dramatically more reliable LLM code generation, because:

1. The topology layer is flat, declarative, and formally verifiable in milliseconds
2. The action layer consists of small, pure, isolated functions — exactly what LLMs generate best
3. Errors in one layer don't invalidate the other
4. Each layer has different verification strategies matched to its error profile

The designer has significant prior experience with:
- **BPEL engine design and implementation** (built on G2 operations platform, including XML export/import and visual mapping)
- **Formal verification** (active Lean 4 project)
- **AI agent frameworks** (see `~/code/agent_framework` for a related project by collaborator Peter — the "cyberaid" system — worth examining for architectural patterns, especially any state machine or workflow orchestration concepts)
- **XState and statechart patterns** in JavaScript/TypeScript

## What To Build — Phase 1

Implement the core language, parser, verifier, and XState compilation target. Use **TypeScript** as the implementation language.

### Directory Structure

```
orca/
├── docs/
│   └── orca-proposal.md          # The full proposal (copy from provided file)
├── src/
│   ├── parser/
│   │   ├── lexer.ts              # Tokenizer for Orca syntax
│   │   ├── parser.ts             # Parser producing Orca AST
│   │   └── ast.ts                # AST type definitions
│   ├── verifier/
│   │   ├── structural.ts         # Reachability, deadlock, orphan checks
│   │   ├── completeness.ts       # Event handling completeness
│   │   ├── determinism.ts        # Guard mutual exclusion / exhaustiveness
│   │   └── types.ts              # Verification result types
│   ├── compiler/
│   │   ├── xstate.ts             # Compile Orca AST -> XState v5 machine config
│   │   └── mermaid.ts            # Compile Orca AST -> Mermaid stateDiagram
│   ├── runtime/
│   │   └── effects.ts            # Effect routing and execution
│   └── index.ts                  # CLI entry point
├── examples/
│   ├── payment-processor.orca    # The example from the proposal
│   ├── text-adventure.orca       # The retro-quest style example
│   └── simple-toggle.orca        # Minimal example for testing
├── tests/
│   ├── parser.test.ts
│   ├── verifier.test.ts
│   └── compiler.test.ts
├── package.json
├── tsconfig.json
└── README.md
```

### Implementation Order

1. **AST types** (`src/parser/ast.ts`) — Define the type system for Orca machines: Machine, State, Transition, Guard, Action signature, Context type, Event vocabulary. This is the foundation everything else depends on.

2. **Parser** (`src/parser/lexer.ts`, `src/parser/parser.ts`) — Parse the Orca syntax from the proposal (section 3) into the AST. Start with flat transition tables only (no hierarchy, no parallel regions). The syntax should be:
   - Machine declaration with context and events
   - State declarations with `[initial]` / `[final]` markers, descriptions, `on_entry`/`on_exit`
   - Flat transition table: `source + event [guard] -> target : action`
   - Guard definitions as named boolean expressions
   - Action signature declarations

3. **Topology verifier** (`src/verifier/`) — Implement the checks from proposal section 5.1:
   - All states reachable from initial state
   - No non-final states without outgoing transitions
   - No final states with outgoing transitions (except ignored events)
   - Completeness: every (state, event) pair handled or explicitly ignored
   - Determinism: guards on multi-transition pairs are mutually exclusive
   - No orphan events or actions
   - Output specific, actionable error messages (designed to be fed back to an LLM)

4. **XState compiler** (`src/compiler/xstate.ts`) — Compile verified Orca AST to XState v5 machine configuration. This should produce a valid `createMachine()` call that can run in any XState environment.

5. **Mermaid compiler** (`src/compiler/mermaid.ts`) — Compile Orca AST to Mermaid `stateDiagram-v2` syntax for visual output.

6. **CLI** (`src/index.ts`) — Simple CLI that:
   - `orca verify <file.orca>` — parse + verify, report errors
   - `orca compile xstate <file.orca>` — output XState config
   - `orca compile mermaid <file.orca>` — output Mermaid diagram
   - `orca visualize <file.orca>` — compile to Mermaid and render (or just output for now)

### Key Design Decisions

- **Parser approach**: Use a hand-written recursive descent parser, not a parser generator. The grammar is simple enough and we want good error messages.
- **Verification errors**: Every error should include the specific state/event/transition involved and a suggested fix. These messages will be consumed by LLMs in the feedback loop.
- **XState v5**: Target the current version of XState, not v4. Use `createMachine` with `setup()`.
- **No action implementations yet**: Phase 1 only handles action *signatures* in the topology. The action implementation layer (Phase 2) will come later.
- **Test-driven**: Write tests alongside implementation. The examples directory provides integration test cases.

### Related Code To Examine

Once the basic structure is in place, examine these local repos for patterns and potential integration:

- **`~/code/agent_framework`** — The cyberaid system. Look at its architecture for:
  - Any state machine or workflow patterns
  - How it handles agent coordination (relates to Orca's parallel regions)
  - Effect/action patterns (relates to Orca's effect system)
  - Any orchestration concepts similar to BPEL

- **`~/code/retro-quest`** (if present) — The text adventure game. Look at:
  - How game state transitions are currently handled
  - The `contextBuilder.ts` module
  - Where the LLM narrator integration happens
  - This is a candidate for Orca refactoring once the tool works

### Success Criteria for Phase 1

- [ ] Parse all three example `.orca` files without errors
- [ ] Verify topology and produce correct error messages for intentionally broken machines
- [ ] Compile payment-processor.orca to valid XState v5 config
- [ ] Compile all examples to Mermaid diagrams
- [ ] CLI works for all three commands
- [ ] Tests pass for parser, verifier, and both compilers

## Getting Started

```bash
mkdir orca && cd orca
npm init -y
npm install typescript @types/node tsx vitest --save-dev
npx tsc --init
```

Then copy `docs/orca-proposal.md` into place and start with `src/parser/ast.ts`.
