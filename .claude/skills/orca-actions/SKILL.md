---
name: orca-actions
description: Generate action scaffold code for an Orca machine in TypeScript, Python, or Go. Use when the user has a verified machine and wants implementation stubs for the action functions.
argument-hint: [typescript|python|go] [file]
allowed-tools: Read, mcp__orca__generate_actions
---

Generate action scaffold code for the Orca machine.

Parse $ARGUMENTS:
- First token (if "typescript", "python", or "go") is the language. Default: `typescript`.
- Remaining tokens is the file path or source.

If a file path is given, read the file first.

Call `generate_actions` with the source and lang.

Show the output in a fenced code block with the appropriate language tag.

After showing the output, briefly explain:
- Where to register the actions (e.g. `machine.registerAction(...)` for TS, `@machine.action(...)` decorator for Python, `machine.RegisterAction(...)` for Go)
- That the scaffolds are stubs — the user fills in the business logic

Do not add boilerplate explanation beyond this. The scaffold code is self-documenting.
