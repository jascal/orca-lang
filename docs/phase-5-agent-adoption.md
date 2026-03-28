# Phase 5: Agent Adoption & Distribution

## Problem Statement

Orca's language, verifier, runtimes, and skills are feature-complete for v1. The gap is distribution and integration: nothing is installable, and the interface between Orca and an external agent system requires file I/O instead of in-memory tool calls.

The target for this phase: an AI agent system (OpenClaw, AutoGen, Claude, GPT-4 tools) should be able to discover, install, and use Orca without cloning the repo, without writing files to disk, and without reading source code to understand the API.

The work divides into three tracks that can proceed in parallel:

- **Track A — Distribution**: make packages installable
- **Track B — MCP Server**: make skills callable as agent tools
- **Track C — Skill Completeness**: fill gaps that block agent workflows

---

## Current State

### What works (if you clone the repo)
- All 5 skills: `/verify-orca`, `/compile-orca`, `/generate-orca`, `/generate-actions`, `/refine-orca`
- CLI: `orca verify`, `orca compile`, `orca actions`, `orca convert`, `orca visualize`
- JSON output on all commands (`--json` flag) — already structured for agent consumption
- Three runtimes at feature parity (TypeScript, Python, Go)

### What doesn't work (for external agent adoption)
- `npm install orca` → package not published
- `npm install @orcalang/orca-runtime-ts` → package not published
- `pip install orca-runtime-python` → package not published
- `go get orca-runtime-go/...` → module path is not a VCS URL, can't be resolved
- Every skill takes a file path — agents work with strings in memory
- No MCP server — modern agent frameworks expect tool definitions with JSON schemas
- No `orca --tools --json` — CLI is not self-describing
- `/generate-actions` only generates TypeScript scaffolds; Python and Go are stubs
- No `/parse-machine` — agents cannot inspect a machine's structure without implementing their own parser
- `/generate-orca` generates one machine at a time — can't design a multi-machine system in one call
- `/refine-orca` is single-pass — if the fixed machine still has errors, the agent must detect this and retry manually

---

## Track A — Distribution

### A1: Fix Go module path

The `runtime-go` module name `orca-runtime-go` is not a VCS URL. Go modules must be a full import path resolving to a repository.

**Change `go.mod`:**
```
module github.com/jascal/orca-lang/packages/runtime-go
```

Update all internal imports and demo-go references accordingly.

### A2: Add `files` field and prepublish build to npm packages

`packages/orca-lang/package.json`:
```json
{
  "files": ["dist/", "src/"],
  "scripts": {
    "prepublishOnly": "npm run build"
  }
}
```

`packages/runtime-ts/package.json`:
```json
{
  "files": ["dist/"],
  "scripts": {
    "prepublishOnly": "npm run build"
  }
}
```

### A3: GitHub Actions — release workflow

`.github/workflows/release.yml`:
- Trigger: push of `v*` tag
- Jobs (parallel):
  - `publish-npm-orca`: build + `npm publish` for `packages/orca-lang`
  - `publish-npm-runtime-ts`: build + `npm publish` for `packages/runtime-ts`
  - `publish-pypi`: `pip build` + `twine upload` for `packages/runtime-python`
  - `tag-go`: tags `packages/runtime-go/vX.Y.Z` for Go module proxy pickup
- Secrets: `NPM_TOKEN`, `PYPI_TOKEN`

### A4: CHANGELOG.md and semver tagging

- Add `CHANGELOG.md` at repo root following Keep a Changelog format
- First entry: `v0.1.0` — document all phases 1–4.5
- Tag current HEAD as `v0.1.0` after packages publish

---

## Track B — MCP Server

### B1: `packages/mcp-server` — new package

An MCP (Model Context Protocol) server that exposes Orca skills as agent tools. Agents connect via stdio (same process) or SSE (HTTP). No files required — all inputs and outputs are strings.

**Package**: `@orcalang/orca-mcp-server`

**Tools exposed:**

| Tool name | Input schema | Output | Notes |
|---|---|---|---|
| `verify_machine` | `{ source: string }` | `VerifySkillResult` | Accepts raw markdown, no file required |
| `compile_machine` | `{ source: string, target?: 'xstate' \| 'mermaid' }` | `CompileSkillResult` | |
| `generate_machine` | `{ spec: string }` | `GenerateOrcaResult` | Requires LLM config |
| `generate_actions` | `{ source: string, lang?: string }` | `GenerateActionsResult` | |
| `refine_machine` | `{ source: string, errors?: SkillError[] }` | `RefineResult` | Loops until valid or max_iterations |
| `parse_machine` | `{ source: string }` | `ParseResult` (AST as JSON) | New — see Track C |

**Implementation approach:**

The skills in `src/skills.ts` currently read files from disk. Refactor them to accept `source: string` directly (the file path becomes optional — if provided, read the file; if not, use the source string). The MCP server passes source strings.

```typescript
// packages/mcp-server/src/server.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { verifySkill, compileSkill, generateSkill, generateActionsSkill, refineSkill } from 'orca/skills';

const server = new Server({ name: 'orca', version: '0.1.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [/* tool definitions with JSON schemas */]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  switch (request.params.name) {
    case 'verify_machine': return verifySkill({ source: request.params.arguments.source });
    // ...
  }
});
```

### B2: Stdin support on CLI

All commands should accept source via stdin when no file path is given:

```bash
# These should all work:
cat machine.orca.md | orca verify --stdin
echo "# machine Foo..." | orca compile xstate --stdin
orca verify --stdin < machine.orca.md
```

Implementation: in `src/index.ts`, if the file path argument is `--stdin` or absent and stdin is not a TTY, read from `process.stdin`.

### B3: Tool discovery command

```bash
orca --tools --json
```

Returns a JSON array of available tools with their parameter schemas — the same schemas used in the MCP server. Allows agent frameworks that use the CLI directly (not MCP) to discover capabilities programmatically.

---

## Track C — Skill Completeness

### C1: Refactor skills to accept `source` strings

**Pre-requisite for the MCP server.** Currently all skills in `src/skills.ts` call `readFileSync(filePath)` internally. Refactor to:

```typescript
interface SkillInput {
  source?: string;   // raw markdown content
  file?: string;     // path to .orca.md file (one of source or file required)
}
```

This is a non-breaking change — existing CLI usage passes `file`, MCP server passes `source`.

### C2: `/parse-machine` skill (new)

Returns the parsed AST as JSON. Foundational for agent introspection:

```typescript
interface ParseSkillResult {
  status: 'success' | 'error';
  machine?: {
    name: string;
    states: string[];                     // flat list of state names
    events: string[];
    transitions: ParsedTransition[];      // { source, event, guard, target, action }
    guards: { name: string, expression: string }[];
    actions: { name: string, hasEffect: boolean, effectType?: string }[];
    effects?: { name: string, input: string, output: string }[];
    context: { name: string, type: string, default?: string }[];
  };
  error?: string;
}
```

Use case: an agent building a diagram, generating tests, or doing impact analysis on a machine change.

### C3: `/generate-actions` for Python and Go

The skill has `--lang` support but only TypeScript templates are fully implemented.

**Python scaffolds:**
```python
# Action: send_authorization_request
# Effect: AuthRequest

async def send_authorization_request(ctx: dict, event: dict) -> tuple[dict, dict]:
    # TODO: Implement action
    return ctx, {"type": "AuthRequest", "payload": {}}
```

**Go scaffolds:**
```go
// Action: send_authorization_request
// Effect: AuthRequest

func SendAuthorizationRequest(ctx map[string]any, event orca.Event) (map[string]any, map[string]any) {
    // TODO: Implement action
    return ctx, map[string]any{"type": "AuthRequest"}
}
```

**Test scaffolds for Python:** use `pytest`, mock event bus, assert context shape.
**Test scaffolds for Go:** use `testing`, table-driven tests.

### C4: `/generate-orca-multi` skill (new)

Generate a coordinated set of machines from a single spec. Returns multiple machine definitions in one `.orca.md` (separated by `---`) that pass the cross-machine verifier.

```typescript
interface GenerateMultiResult {
  status: 'success' | 'error' | 'requires_refinement';
  machines: string[];          // names of generated machines
  orca: string;                // full multi-machine .orca.md content
  verification: VerifySkillResult;
  error?: string;
}
```

**Implementation:** extend `/generate-orca`'s LLM prompt to describe multi-machine syntax and `invoke:` semantics; add cross-machine verification step in the refinement loop.

### C5: Loop `/refine-orca` to convergence

Currently single-pass. After LLM correction, verify again and retry up to `max_iterations` (default 3, matching `/generate-orca`):

```typescript
// In skills.ts refineSkill():
for (let i = 0; i < maxIterations; i++) {
  const corrected = await llm.correct(source, errors);
  const verification = verifySource(corrected);
  if (verification.valid) return { status: 'success', corrected, iterations: i + 1 };
  errors = verification.errors;
  source = corrected;
}
return { status: 'requires_refinement', corrected: source, errors };
```

### C6: Error catalog (`docs/error-catalog.md`)

A machine-readable reference for all verifier error codes. Format:

```markdown
## ORPHAN_EFFECT

**Severity**: warning
**Message pattern**: `Effect 'X' is declared but never referenced by any action`
**Cause**: An effect is listed in `## effects` but no action in `## actions` has `effectType: X`.
**Fix**: Either add `| X | Effect |` to the relevant action's row, or remove X from `## effects`.
**Example**: ...
```

Covers all current codes: `NO_INITIAL_STATE`, `UNREACHABLE_STATE`, `DEADLOCK`, `FINAL_STATE_OUTGOING`, `ORPHAN_EVENT`, `ORPHAN_ACTION`, `ORPHAN_EFFECT`, `UNDECLARED_EFFECT`, `MISSING_TRANSITION`, `GUARD_CONFLICT`, `GUARD_EXHAUSTIVENESS`, `CIRCULAR_INVOCATION`, `UNKNOWN_MACHINE`, `CHILD_NO_FINAL_STATE`, `UNKNOWN_ON_DONE_EVENT`, `UNKNOWN_ON_ERROR_EVENT`, `MISSING_ON_ERROR`, `INVALID_INPUT_MAPPING`, `STATE_LIMIT_EXCEEDED`.

### C7: `AGENTS.md` — external agent integration guide

Not a CLAUDE.md variant. Written for an engineer integrating Orca into an agent framework like OpenClaw, AutoGen, or a custom tool-calling loop.

Sections:
- **What Orca provides** — the tool set and what each tool does
- **Installation** — npm, pip, go get, or MCP server
- **The generation loop** — canonical design → verify → refine → compile → scaffold pattern with pseudocode
- **Handling LLM auth** — when to use Orca's built-in LLM vs. passing your own (the `--no-llm` pattern and piping corrected source back in)
- **Working without files** — using `--stdin` and `source` strings via MCP
- **Error codes reference** — link to error catalog
- **Multi-machine workflows** — how to use `/generate-orca-multi` and the cross-machine verifier
- **Extending the runtimes** — how to register custom effect handlers in each language

---

## Implementation Order

The tracks are mostly independent, but within each track the ordering matters:

```
A1 (Go module path)  ─────────────────────────────────> A3 (CI/CD) ─> A4 (tag + CHANGELOG)
A2 (npm files field) ──────────────────────────────────^

C1 (source strings)  ──> B1 (MCP server) ─> B2 (stdin) ─> B3 (--tools)
                     ──> C2 (/parse-machine)
                     ──> C3 (Python/Go actions)
                     ──> C4 (/generate-orca-multi)
                     ──> C5 (loop /refine-orca)

C6 (error catalog)   ──> C7 (AGENTS.md)     [independent, can start anytime]
```

### Suggested step sequence

| Step | Work item | Depends on | Deliverable |
|---|---|---|---|
| 5.1 | C1 — refactor skills to accept `source` | — | Skills work without files |
| 5.2 | A1 — fix Go module path | — | `go get` works |
| 5.3 | A2 — npm `files` + prepublish | — | `npm publish` works correctly |
| 5.4 | C2 — `/parse-machine` | 5.1 | AST introspection tool |
| 5.5 | B1 — MCP server | 5.1, 5.4 | Agent frameworks can connect |
| 5.6 | B2 — stdin support | 5.1 | `cat foo.orca.md \| orca verify` |
| 5.7 | C3 — Python + Go action scaffolds | — | Three-language `/generate-actions` |
| 5.8 | C5 — loop `/refine-orca` | — | Self-healing refinement |
| 5.9 | C4 — `/generate-orca-multi` | 5.1 | Multi-machine generation |
| 5.10 | B3 — `orca --tools --json` | 5.5 | Self-describing CLI |
| 5.11 | C6 — error catalog | — | Machine-readable error reference |
| 5.12 | C7 — `AGENTS.md` | 5.5, 5.6, 5.11 | Agent integration guide |
| 5.13 | A3 — GitHub Actions release workflow | 5.2, 5.3 | Automated publishing |
| 5.14 | A4 — CHANGELOG + v0.1.0 tag | 5.13 | First published release |

---

## Success Criteria

Phase 5 is complete when:

- [ ] `npm install orca` installs the CLI and library
- [ ] `npm install @orcalang/orca-runtime-ts` installs the TypeScript runtime
- [ ] `pip install orca-runtime-python` installs the Python runtime
- [ ] `go get github.com/jascal/orca-lang/packages/runtime-go` works
- [ ] The MCP server is published and an agent can connect and call all 6 tools (including `/parse-machine`) with string inputs — no files
- [ ] `cat machine.orca.md | orca verify --stdin` works
- [ ] `/generate-actions --lang python` and `--lang go` produce runnable scaffolds
- [ ] `/refine-orca` loops to convergence (or reports `requires_refinement` after N attempts)
- [ ] `/generate-orca-multi` produces a multi-machine file that passes the cross-machine verifier
- [ ] Error catalog documents all 19 current error codes
- [ ] `AGENTS.md` provides a complete integration guide for external agent frameworks
- [ ] GitHub Actions publishes on tag push; `v0.1.0` tag exists on the repo
