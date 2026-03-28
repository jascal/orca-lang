---
name: orca-generate-multi
description: Generate a coordinated multi-machine Orca system from a natural language spec. Use when the user needs multiple state machines that invoke each other (e.g. a coordinator with child workers).
argument-hint: <spec>
allowed-tools: mcp__orca__generate_multi_machine, mcp__orca__verify_machine, mcp__orca__compile_machine
---

Generate a multi-machine Orca system from this spec: $ARGUMENTS

Follow this sequence:

1. Call `generate_multi_machine` with the spec. Check the result:
   - `"success"`: proceed to step 2.
   - `"requires_refinement"`: show the remaining errors with suggestions, explain which machines had issues, and stop. The user may want to simplify the spec or fix manually.
   - `"error"`: report and stop.

2. Show the full `.orca.md` source (all machines, separated by `---`) in a fenced markdown code block.

3. List the machines generated (from `result.machines`) and briefly describe the invocation topology — which machine is the coordinator and what it invokes.

4. Offer to:
   - Compile any individual machine to XState (`/orca-compile xstate`)
   - Generate action scaffolds for all machines in a chosen language (`/orca-actions`)

Keep the explanation of the topology to 2-3 sentences. The source is the authoritative description.
