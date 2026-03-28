---
name: orca-verify
description: Verify an Orca machine for structural correctness, completeness, and determinism. Use when the user wants to check a .orca.md file for errors or warnings.
argument-hint: [file]
allowed-tools: Read, mcp__orca__verify_machine
---

Verify the Orca machine definition.

If $ARGUMENTS is a file path, read the file first, then call `verify_machine` with its contents.
If $ARGUMENTS is empty and there is an active file in the conversation, use that.
If $ARGUMENTS is raw `.orca.md` source, pass it directly.

After calling `verify_machine`:

- If `status` is `"valid"`: confirm it's valid and list any warnings with their `suggestion` fields.
- If `status` is `"invalid"`: list each error grouped by severity (errors first, then warnings). For each, show: code, message, and suggestion. Ask if the user wants to run `/orca-refine` to fix the errors automatically.

Do not paraphrase the errors — show them as-is from the tool output.
