---
name: orca-generate
description: Generate a verified Orca state machine from a natural language spec. Use when the user wants to design a new state machine, workflow, or agent orchestration from a description.
argument-hint: <spec>
allowed-tools: mcp__orca__generate_machine, mcp__orca__verify_machine, mcp__orca__refine_machine, mcp__orca__compile_machine
---

Generate a verified Orca state machine from this spec: $ARGUMENTS

Follow this sequence exactly:

1. Call `generate_machine` with the spec. If `status` is `"success"`, proceed to step 3. If `"requires_refinement"`, proceed to step 2. If `"error"`, report the error and stop.

2. Call `refine_machine` with the `orca` source and the returned `errors`. Repeat until `status` is `"success"` or `max_iterations` is exhausted — then surface the remaining errors and stop.

3. Call `compile_machine` with `target: "xstate"` and show the TypeScript config to the user.

4. Show the final `.orca.md` source in a fenced markdown code block so the user can save it.

5. Offer to call `generate_actions` for TypeScript, Python, or Go scaffold code if the user wants it.

Keep your explanations brief. Let the tool output speak — show the machine source and compiled code, not a summary of what you did.
