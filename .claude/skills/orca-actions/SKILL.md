---
name: orca-actions
description: Generate action scaffold code for an Orca machine in TypeScript, Python, or Go. Use when the user has a verified machine and wants implementation stubs for the action functions. When the machine file also contains decision tables, compiled evaluator functions and wired action stubs are included automatically.
argument-hint: [typescript|python|go] [file]
allowed-tools: Read, mcp__orca__generate_actions
---

Generate action scaffold code for the Orca machine.

Parse $ARGUMENTS:
- First token (if "typescript", "python", or "go") is the language. Default: `typescript`.
- Remaining tokens is the file path or source.

If a file path is given, read the file first.

Call `generate_actions` with the source and lang.

## Presenting the output

### Action scaffolds (`scaffolds`)

Show all action stubs in a single fenced code block with the appropriate language tag (`typescript`, `python`, or `go`).

### Decision table evaluators (`decisionTableCode`)

If the result contains `decisionTableCode` (a map of DT name → compiled evaluator code), show each evaluator in its own fenced code block, labeled with the DT name:

```
// Decision table: PaymentRouting
<evaluator code>
```

Place the DT evaluator blocks **after** the action scaffolds.

### Registration reminder

After showing the output, briefly explain:
- Where to register the actions (e.g. `machine.registerAction(...)` for TS, `@machine.action(...)` decorator for Python, `machine.RegisterAction(...)` for Go)
- That action stubs matching a decision table include a commented example call — the user fills in the context field mappings
- That DT evaluator code should be placed in the same file or imported alongside the actions

## Decision table wiring

When a `.orca.md` file contains both a machine and one or more `# decision_table` blocks:

1. **Evaluators are compiled automatically** for each DT in the target language (TypeScript/Python/Go).
2. **Matching action stubs** — actions whose name tokens overlap with a DT name (e.g. `apply_routing_decision` ↔ `PaymentRouting` via "routing") — receive a commented example of how to call the evaluator, showing all input conditions and output fields with `// TODO: map from ctx` annotations.
3. **Non-matching actions** receive plain stubs as usual.

The user is responsible for mapping context fields to DT inputs and applying DT outputs back to context. The generated stubs provide the full evaluator signature as a guide.

Do not add boilerplate explanation beyond this. The scaffold code is self-documenting.
