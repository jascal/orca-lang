---
name: orca-refine
description: Automatically fix verification errors in an Orca machine using an LLM. Use when verify_machine returns errors and the user wants them fixed.
argument-hint: [file]
allowed-tools: Read, mcp__orca__verify_machine, mcp__orca__refine_machine
---

Fix verification errors in the Orca machine.

If $ARGUMENTS is a file path, read the file first.
If $ARGUMENTS is empty and there is an active file in the conversation, use that.

1. Call `verify_machine` with the source. If `status` is `"valid"`, tell the user the machine is already valid and stop.

2. Call `refine_machine` with the source and the `errors` array from step 1.

3. Report the result:
   - `"success"`: show the corrected `.orca.md` source and list the `changes` made. Offer to write it back to the file if one was provided.
   - `"requires_refinement"`: show how many iterations were attempted, list the remaining errors with their `suggestion` fields, and ask if the user wants to try again or fix manually.
   - `"error"`: show the error message.

When writing back to a file, confirm with the user before overwriting.
