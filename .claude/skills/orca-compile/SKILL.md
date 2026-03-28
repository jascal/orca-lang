---
name: orca-compile
description: Compile an Orca machine to XState v5 TypeScript config or a Mermaid state diagram. Use when the user wants to generate runnable code or a visual diagram from a .orca.md file.
argument-hint: [xstate|mermaid] [file]
allowed-tools: Read, mcp__orca__compile_machine
---

Compile the Orca machine.

Parse $ARGUMENTS:
- First token (if present and is "xstate" or "mermaid") is the target. Default: `xstate`.
- Remaining tokens (or all of $ARGUMENTS if no target token) is the file path or source.

If a file path is given, read the file first.

Call `compile_machine` with the source and target.

Show the output in a fenced code block with the appropriate language tag:
- `xstate` target → ` ```typescript `
- `mermaid` target → ` ```mermaid `

For `xstate` output, add a brief note about which runtime to use:
- TypeScript: `@orcalang/orca-runtime-ts`
- Or XState directly if the user already has it

For `mermaid` output, note it can be rendered at mermaid.live or in any Mermaid-compatible renderer.
