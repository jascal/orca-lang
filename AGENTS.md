# Orca — Agent Integration Guide

This guide is for engineers integrating Orca into an agent framework (Claude tool use, OpenAI function calling, AutoGen, OpenClaw, or a custom tool loop). It covers installation, the canonical generation loop, working with strings instead of files, multi-machine workflows, and extending the runtimes.

---

## What Orca Provides

Orca is a **state machine language** designed as an LLM code generation target. It separates program topology (state machine structure, verified by static analysis) from computation (action functions, implemented in your language of choice).

The agent-facing interface is a set of tools:

| Tool | What it does |
|------|-------------|
| `parse_machine` | Parse `.orca.md` source → structured JSON (states, events, transitions, guards, actions, context) |
| `verify_machine` | Structurally verify a machine → errors and warnings with codes and suggestions |
| `compile_machine` | Compile to XState v5 TypeScript config or Mermaid `stateDiagram-v2` |
| `generate_machine` | Generate an Orca machine from a natural language spec (requires LLM) |
| `generate_multi_machine` | Generate a coordinated multi-machine system from a natural language spec (requires LLM) |
| `generate_actions` | Generate action scaffold code in TypeScript, Python, or Go |
| `refine_machine` | Fix verification errors using an LLM, looping until valid or `max_iterations` reached |

All tools accept `source: string` — raw `.orca.md` content. No files required.

---

## Installation

### MCP Server (recommended for modern agent frameworks)

```bash
npm install -g @orcalang/orca-mcp-server

# Or run directly with npx
npx @orcalang/orca-mcp-server
```

Configure in your MCP host (e.g. Claude Code `settings.json` or project `.mcp.json`):

```json
{
  "mcpServers": {
    "orca": {
      "command": "npx",
      "args": ["-y", "@orcalang/orca-mcp-server"],
      "env": {
        "ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY}"
      }
    }
  }
}
```

`${VAR}` syntax passes your shell's `ANTHROPIC_API_KEY` environment variable into the MCP server process. Make sure it is set before starting Claude Code.

The server speaks the [Model Context Protocol](https://modelcontextprotocol.io) over stdio. It exposes all 7 tools with full JSON schemas. The server requires **Node.js 20+** and exits with a clear error on older versions.

### CLI (for agent frameworks that use subprocesses)

```bash
npm install -g orca
```

Discover tools programmatically:

```bash
orca --tools --json   # returns JSON array of tool definitions with input schemas
```

Use stdin to avoid writing temp files:

```bash
echo "$orca_source" | orca verify --stdin
echo "$orca_source" | orca /parse-machine --stdin
echo "$orca_source" | orca compile xstate --stdin
```

All commands support `--json` for structured output:

```bash
orca verify --json machine.orca.md
orca /verify-orca machine.orca.md        # always returns JSON
```

### TypeScript library

```bash
npm install @orcalang/orca-lang
```

```typescript
import { verifySkill, compileSkill, parseSkill } from 'orca-lang/skills';

const result = await verifySkill({ source: orcaSource });
```

### Python runtime

```bash
pip install orca-runtime-python
```

### Go runtime

```bash
go get github.com/jascal/orca-lang/packages/runtime-go
```

---

## The Generation Loop

The canonical pattern for an agent generating and deploying a state machine:

```
1. generate_machine(spec)  →  orca source
2. verify_machine(source)  →  errors?
3.   if errors: refine_machine(source, errors)  →  corrected source  →  go to 2
4. compile_machine(source, 'xstate')  →  TypeScript config
5. generate_actions(source, lang)     →  scaffold code
6. Hand off config + scaffold to the developer
```

In pseudocode (tool-call style):

```python
# Step 1: Generate
result = generate_machine(spec="A payment processor with retry logic, up to 3 attempts")
source = result["orca"]

# Step 2-3: Verify and refine
for i in range(3):
    verification = verify_machine(source=source)
    if verification["status"] == "valid":
        break
    result = refine_machine(source=source, errors=verification["errors"])
    source = result["corrected"]

# Step 4: Compile
xstate = compile_machine(source=source, target="xstate")

# Step 5: Scaffold
scaffolds = generate_actions(source=source, lang="typescript")
```

`generate_machine` and `refine_machine` already implement this loop internally (up to `max_iterations`). You can call them directly and check the returned `status`:

- `"success"` — machine is valid, use `orca`
- `"requires_refinement"` — still has errors after all iterations; inspect `errors` and decide whether to retry or hand off for manual review
- `"error"` — LLM or parse error; inspect `error` message

---

## Handling LLM Auth

| Tool | Calls LLM | Required Key |
|------|-----------|--------------|
| `parse_machine` | No | None |
| `verify_machine` | No | None |
| `compile_machine` | No | None |
| `generate_machine` | Yes | See providers below |
| `generate_multi_machine` | Yes | See providers below |
| `generate_actions` | Only if `use_llm: true` | See providers below |
| `refine_machine` | Yes | See providers below |

Configure the LLM provider via environment variables or an `.orca.env` file. The MCP server passes `env` values from your Claude Code settings directly to the skills.

### Provider Configuration

#### Anthropic (default)

```env
# .env or shell
ANTHROPIC_API_KEY=sk-ant-...
```

```yaml
# orca.yaml / .orca.yaml
provider: anthropic
model: claude-sonnet-4-6
api_key: ${ANTHROPIC_API_KEY}
```

#### MiniMax (via Anthropic-compatible API)

MiniMax uses the same message format as Anthropic but with Bearer auth. Set the base URL to MiniMax's endpoint:

```env
MINIMAX_API_KEY=...
```

```yaml
# orca.yaml / .orca.yaml
provider: anthropic
base_url: https://api.minimaxi.chat/v1
model: MiniMax-Text-01
api_key: ${MINIMAX_API_KEY}
```

The server also accepts `ANTHROPIC_API_KEY` as a fallback if `MINIMAX_API_KEY` is not set.

#### OpenAI (and OpenAI-compatible providers)

```env
OPENAI_API_KEY=sk-...
```

```yaml
# orca.yaml / .orca.yaml
provider: openai
model: gpt-4o
api_key: ${OPENAI_API_KEY}
```

Works with any OpenAI-compatible API by setting `base_url`:

```yaml
provider: openai
base_url: https://api.deepseek.com/v1
model: deepseek-chat
api_key: ${DEEPSEEK_API_KEY}
```

#### Ollama (local models)

```yaml
# orca.yaml / .orca.yaml
provider: ollama
base_url: http://localhost:11434
model: llama3
```

No API key required for local Ollama instances.

### MCP Server Env Config

For the MCP server, set provider keys in your Claude Code settings:

```json
{
  "mcpServers": {
    "orca": {
      "command": "npx",
      "args": ["-y", "@orcalang/orca-mcp-server"],
      "env": {
        "ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY}",
        "MINIMAX_API_KEY": "${MINIMAX_API_KEY}",
        "OPENAI_API_KEY": "${OPENAI_API_KEY}"
      }
    }
  }
}
```

All env vars are passed through; the skills use whichever key matches the configured provider.

**Using your own LLM instead of Orca's**: If your agent already has LLM access, you can bypass Orca's generation tools and generate source directly, then use the deterministic tools (`verify_machine`, `compile_machine`, `parse_machine`) for validation. Pass the LLM-generated `.orca.md` string directly to `verify_machine`. Use `refine_machine` with an explicit `errors` array if you want Orca to attempt correction.

The generation prompt is available in `packages/orca-lang/src/skills.ts` (`ORCA_SYNTAX_REFERENCE` constant) if you want to embed it into your own system prompt.

---

## Working Without Files

All tools accept `source: string` — pass raw `.orca.md` content directly. No temp files needed.

**MCP (recommended)**:
```json
{
  "tool": "verify_machine",
  "arguments": { "source": "# machine Toggle\n\n## state off [initial]\n..." }
}
```

**CLI via stdin**:
```bash
# Pipe from a variable
echo "$source" | orca verify --stdin --json

# Pipe from a file (when you have one)
cat machine.orca.md | orca /verify-orca --stdin

# Use - as the filename to force stdin
orca compile xstate - < machine.orca.md
```

**Library**:
```typescript
import { verifySkill } from 'orca-lang/skills';
const result = await verifySkill({ source: myOrcaString });
```

---

## Error Codes Reference

See [`docs/error-catalog.md`](docs/error-catalog.md) for the full catalog of error codes with causes, fixes, and examples.

Quick reference by category:

| Category | Codes |
|----------|-------|
| Structural | `NO_INITIAL_STATE`, `UNREACHABLE_STATE`, `FINAL_STATE_OUTGOING`, `DEADLOCK` |
| Orphans | `ORPHAN_EVENT`, `ORPHAN_ACTION`, `ORPHAN_EFFECT`, `UNDECLARED_EFFECT` |
| Completeness | `INCOMPLETE_EVENT_HANDLING` |
| Determinism | `NON_DETERMINISTIC`, `GUARD_EXHAUSTIVENESS` |
| Properties | `PROPERTY_REACHABILITY_FAIL`, `PROPERTY_EXCLUSION_FAIL`, `PROPERTY_PATH_FAIL`, `PROPERTY_LIVENESS_FAIL`, `PROPERTY_RESPONSE_FAIL`, `PROPERTY_INVARIANT_*` |
| Multi-machine | `CIRCULAR_INVOCATION`, `UNKNOWN_MACHINE`, `CHILD_NO_FINAL_STATE`, `UNKNOWN_ON_DONE_EVENT`, `UNKNOWN_ON_ERROR_EVENT`, `MISSING_ON_ERROR`, `INVALID_INPUT_MAPPING`, `STATE_LIMIT_EXCEEDED` |
| Size | `MACHINE_TOO_LARGE` |

When an agent encounters a verification error, the recommended handling is:

1. Pass the `errors` array directly to `refine_machine` — it knows how to fix each code
2. If `refine_machine` returns `requires_refinement`, surface the remaining errors to the user with the `suggestion` field from each error
3. `GUARD_EXHAUSTIVENESS`, `ORPHAN_*`, `MISSING_ON_ERROR`, and `PROPERTY_INVARIANT_ADVISORY` are warnings — they do not block compilation or deployment

---

## Multi-machine Workflows

For complex systems, generate a coordinated set of machines in one file:

```python
result = generate_multi_machine(
  spec="An e-commerce order system: coordinator that manages payment, inventory check, and notification in sequence"
)
# result["machines"] = ["OrderCoordinator", "PaymentProcessor", "InventoryCheck", "NotificationSender"]
# result["orca"] = full multi-machine .orca.md content with --- separators
```

Multi-machine files contain machines separated by `---`. States can invoke other machines:

```markdown
# machine OrderCoordinator

## state checking_payment [initial]
- invoke: PaymentProcessor
- on_done: PAYMENT_DONE
- on_error: PAYMENT_FAILED
```

The cross-machine verifier checks:
- All invoked machine names resolve to machines in the same file
- Invoked machines have at least one reachable `[final]` state
- `on_done` and `on_error` events are declared in the parent machine
- No circular invocations
- Combined state count under 64

To verify a multi-machine file:

```bash
orca verify multi-machine.orca.md      # human-readable
orca verify --json multi-machine.orca.md  # structured JSON
```

To parse and inspect the machine structure:

```bash
orca /parse-machine multi-machine.orca.md
# Returns: { machines: [{name, states, transitions, ...}, ...] }
```

---

## Extending the Runtimes

After generating and compiling a machine, you connect it to your business logic by registering action handlers.

### TypeScript (`@orcalang/orca-runtime-ts`)

```typescript
import { parseOrcaAuto, OrcaMachine } from '@orcalang/orca-runtime-ts';

const { file } = parseOrcaAuto(source);
const machine = new OrcaMachine(file.machines[0]);

// Register plain action (returns updated context)
machine.registerAction('send_confirmation', async (ctx, event) => {
  await emailService.send(ctx.email, 'Confirmed');
  return { ...ctx, confirmed: true };
});

// Register effect action (returns context + effect payload)
machine.registerAction('charge_card', async (ctx, event) => {
  return [{ ...ctx }, { type: 'ChargeRequest', payload: { amount: ctx.amount } }];
});

// Handle emitted effects
machine.onEffect('ChargeRequest', async (payload) => {
  return await paymentGateway.charge(payload.amount);
});

machine.start({ email: 'user@example.com', amount: 100 });
machine.send('SUBMIT');
```

### Python (`orca-runtime-python`)

```python
from orca_runtime_python import parse_orca_auto, OrcaMachine

source = open("machine.orca.md").read()
file = parse_orca_auto(source)
machine = OrcaMachine(file.machines[0])

# Register plain action
@machine.action("send_confirmation")
async def send_confirmation(ctx: dict, event: dict) -> dict:
    await email_service.send(ctx["email"], "Confirmed")
    return {**ctx, "confirmed": True}

# Register effect action
@machine.action("charge_card")
async def charge_card(ctx: dict, event: dict) -> tuple[dict, dict]:
    return ctx, {"type": "ChargeRequest", "payload": {"amount": ctx["amount"]}}

# Handle emitted effects
@machine.bus.effect_handler("ChargeRequest")
async def handle_charge(payload: dict) -> dict:
    return await payment_gateway.charge(payload["amount"])

await machine.start({"email": "user@example.com", "amount": 100})
await machine.send("SUBMIT")
```

### Go (`github.com/jascal/orca-lang/packages/runtime-go`)

```go
import (
    orca "github.com/jascal/orca-lang/packages/runtime-go/orca_runtime_go"
)

source, _ := os.ReadFile("machine.orca.md")
file, _ := orca.ParseOrcaAuto(string(source))
machine := orca.NewOrcaMachine(file.Machines[0], bus)

// Register plain action
machine.RegisterAction("send_confirmation", func(ctx map[string]any, event orca.Event) map[string]any {
    emailService.Send(ctx["email"].(string), "Confirmed")
    ctx["confirmed"] = true
    return ctx
})

// Register effect handler on the bus
bus.SetEffectHandler("ChargeRequest", func(payload map[string]any) (map[string]any, error) {
    return paymentGateway.Charge(payload["amount"].(float64))
})

machine.Start(map[string]any{"email": "user@example.com", "amount": 100.0})
machine.Send(orca.Event{Type: "SUBMIT"})
```

### Persistence and Resume

All three runtimes support snapshot/restore for fault-tolerant deployments:

```typescript
// TypeScript
const adapter = new FilePersistence('./checkpoints/machine.jsonl');
machine.setPersistenceAdapter(adapter);

// Later, after a crash:
const snapshot = await adapter.load();
if (snapshot) {
  await machine.resume(snapshot);  // cold-boot without re-running on_entry
}
```

```python
# Python
from orca_runtime_python import FilePersistence
adapter = FilePersistence("./checkpoints/machine.jsonl")
machine.set_persistence_adapter(adapter)

snapshot = await adapter.load()
if snapshot:
    await machine.resume(snapshot)
```

```go
// Go
adapter := orca.NewFilePersistence("./checkpoints/machine.jsonl")
machine.SetPersistenceAdapter(adapter)

snapshot, err := adapter.Load()
if err == nil && snapshot != nil {
    machine.Resume(*snapshot)
}
```

---

## The `.orca.md` Format

Machines are defined in standard markdown. The format is designed to be readable and writable by LLMs.

```markdown
# machine PaymentProcessor

## context

| Field       | Type    | Default |
|-------------|---------|---------|
| amount      | decimal |         |
| retry_count | int     | 0       |
| authorized  | bool    | false   |

## events

- AUTHORIZE
- RETRY
- CANCEL

## state pending [initial]
> Waiting to start authorization

## state authorizing
> Authorization in progress

## state authorized [final]
> Payment authorized successfully

## state failed [final]
> Authorization failed after all retries

## transitions

| Source       | Event     | Guard          | Target       | Action               |
|--------------|-----------|----------------|--------------|----------------------|
| pending      | AUTHORIZE |                | authorizing  | send_auth_request    |
| authorizing  | RETRY     | can_retry      | authorizing  | send_auth_request    |
| authorizing  | RETRY     | !can_retry     | failed       |                      |
| authorizing  | AUTHORIZE |                | authorized   | record_authorization |
| authorizing  | CANCEL    |                | failed       |                      |

## guards

| Name      | Expression              |
|-----------|-------------------------|
| can_retry | `ctx.retry_count < 3`   |

## actions

| Name                  | Signature                                              |
|-----------------------|--------------------------------------------------------|
| send_auth_request     | `(ctx, event) -> Context + Effect<AuthRequest>`        |
| record_authorization  | `(ctx) -> Context`                                     |
```

Key rules:
- Exactly one `[initial]` state required
- `[final]` states are terminal (no outgoing transitions)
- Guards use only: comparisons (`< > == != <= >=`), null checks, `and`/`or`/`not`
- Action signatures declare types only — implementations are registered at runtime
- `Effect<T>` in a signature means the action emits an effect payload of type `T`
- Multi-machine files separate machines with `---` on its own line

Full grammar reference: see [`packages/orca-lang/src/parser/markdown-parser.ts`](packages/orca-lang/src/parser/markdown-parser.ts).
