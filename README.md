# Orca

**Orchestrated State Machine Language** — a two-layer architecture for reliable LLM code generation.

The core insight: LLMs generate flat transition tables reliably, but they struggle to guarantee topology correctness on their own. Orca separates *program structure* (state machine topology) from *computation* (action functions), then verifies the structure automatically before any code runs.

Machines are written in plain Markdown — a format LLMs can read and write natively.

---

## What it looks like

```markdown
# machine PaymentProcessor

## context

| Field       | Type    | Default |
|-------------|---------|---------|
| order_id    | string  |         |
| amount      | decimal |         |
| retry_count | int     | 0       |

## events

- submit_payment
- payment_authorized
- payment_declined
- retry_requested
- settlement_confirmed

## state idle [initial]
> Waiting for a payment submission

## state authorizing
> Waiting for payment gateway response
- on_entry: send_authorization_request

## state declined
> Payment was declined

## state settled [final]
> Payment fully settled

## transitions

| Source      | Event                | Guard      | Target      | Action           |
|-------------|----------------------|------------|-------------|------------------|
| idle        | submit_payment       |            | authorizing |                  |
| authorizing | payment_authorized   |            | settled     |                  |
| authorizing | payment_declined     |            | declined    |                  |
| declined    | retry_requested      | can_retry  | authorizing | increment_retry  |
| declined    | retry_requested      | !can_retry | settled     | record_failure   |

## guards

| Name      | Expression              |
|-----------|-------------------------|
| can_retry | `ctx.retry_count < 3`   |

## actions

| Name                       | Signature                                | Effect      |
|----------------------------|------------------------------------------|-------------|
| send_authorization_request | `(ctx) -> Context`                       | AuthRequest |
| increment_retry            | `(ctx) -> Context`                       |             |
| record_failure             | `(ctx) -> Context`                       |             |

## effects

| Name        | Input                              | Output                   |
|-------------|------------------------------------|--------------------------|
| AuthRequest | `{ order_id: string, amount: decimal }` | `{ token: string }`  |
```

The verifier checks this before anything runs: reachability, deadlocks, guard determinism, orphan declarations, and effect consistency.

---

## Features

**Language**
- States with `[initial]` / `[final]` markers, descriptions, `on_entry` / `on_exit` actions
- Transitions as a flat table — the format LLMs generate most reliably
- Guard expressions: comparisons, boolean logic, null checks
- Hierarchical (nested) states
- Parallel regions with `all-final` / `any-final` / `custom` sync strategies
- Timeouts: `timeout: 30s -> state_name`
- Ignored events: `ignore: EVENT_NAME`
- Machine invocation: one machine calling another, with input mapping and completion events
- Multi-machine files: multiple machines in one `.orca.md` separated by `---`
- `## effects` section: named I/O schemas for external side effects

**Verifier**
- Reachability: every state is reachable from the initial state
- Deadlock detection: every non-final state has an outgoing transition
- Completeness: every (state, event) pair is handled or explicitly ignored
- Guard determinism: multi-transition guards are mutually exclusive
- Property checking: bounded model checking with BFS — `reachable`, `unreachable`, `passes_through`, `live`, `responds`, `invariant`
- Cross-machine: cycle detection, child reachability to final state, input mapping validation
- Effect consistency: `ORPHAN_EFFECT` (declared but unused) and `UNDECLARED_EFFECT` (referenced but not declared)

**Compilers**
- XState v5 `createMachine()` config
- Mermaid `stateDiagram-v2`

**Runtimes** (standalone — no XState dependency)
- TypeScript (`@orca-lang/orca-runtime-ts`)
- Python (`orca-runtime-python`)
- Go (`orca-runtime-go`)

All three runtimes share the same feature set: guard evaluation, action registration, event bus (pub/sub + request/response), timeouts, parallel regions, snapshot/restore, machine invocation, persistence, and structured logging.

---

## Monorepo structure

```
packages/
  orca-lang/       Core: parser, verifier, XState/Mermaid compiler, CLI
  runtime-ts/      TypeScript runtime
  runtime-python/  Python async runtime
  runtime-go/      Go runtime
  demo-ts/         Text adventure game (uses runtime-ts)
  demo-python/     Agent framework scenarios (uses runtime-python)
  demo-go/         Ride-hailing coordinator — 5 machines (uses runtime-go)
  demo-nanolab/    nanoGPT training orchestrator — 5 machines (uses runtime-python)
```

---

## Setup

```bash
# TypeScript packages
pnpm install
pnpm build

# Python packages (runtime + demos, requires Python >= 3.11)
pnpm run setup:python

# Go packages
pnpm run setup:go
pnpm run build:demo-go
```

---

## CLI

```bash
cd packages/orca-lang

# Verify a machine
npx tsx src/index.ts verify examples/payment-processor.orca.md

# Compile to XState
npx tsx src/index.ts compile xstate examples/payment-processor.orca.md

# Compile to Mermaid
npx tsx src/index.ts compile mermaid examples/text-adventure.orca.md

# Convert legacy .orca to .orca.md
# npx tsx src/index.ts convert <path-to-legacy.orca>
```

---

## Language features

### Parallel regions

```markdown
## state processing [parallel]
> Payment and notification run concurrently
- on_done: -> completed

### region payment_flow

#### state charging [initial]
#### state paid [final]

### region notification_flow

#### state sending_email [initial]
#### state notified [final]
```

The machine transitions to `completed` when both regions reach their final state (`all-final` sync, the default).

### Machine invocation

```markdown
---

# machine OrderCoordinator

## state processing_payment
- invoke: PaymentProcessor
- on_done: payment_confirmed
- on_error: payment_failed

---

# machine PaymentProcessor

## state idle [initial]
## state settled [final]
...
```

The parent owns the child's lifecycle: starts it on entry, stops it on exit. The child's context is isolated from the parent's.

### Timeouts

```markdown
## state waiting_for_response
> LLM call in progress
- timeout: 30s -> timed_out
```

### Snapshot and resume

All runtimes support saving and restoring machine state:

```typescript
// Save
const snap = machine.snapshot();
persistence.save('run-id', snap);

// Resume later (without re-running on_entry)
const snap = persistence.load('run-id');
await machine.resume(snap);
```

### Structured logging

```typescript
import { MultiSink, FileSink, ConsoleSink, makeEntry } from '@orca-lang/orca-runtime-ts';

const sink = new MultiSink(new ConsoleSink(), new FileSink('audit.jsonl'));

const m = new OrcaMachine(def, bus, {
  onTransition: (oldState, newState) => {
    sink.write(makeEntry({ runId, machine: def.name, from: oldState.toString(), to: newState.toString(), ... }));
  }
});
```

---

## Using a runtime

### TypeScript

```typescript
import { parseOrcaAuto, OrcaMachine, EventBus } from '@orca-lang/orca-runtime-ts';

const def = parseOrcaAuto(source);
const bus = new EventBus();
const machine = new OrcaMachine(def, bus);

machine.registerAction('send_authorization_request', (ctx, event) => {
  return { ...ctx, payment_token: 'tok_123' };
});

machine.start();
machine.send({ type: 'submit_payment', payload: { order_id: 'ord_1', amount: 99.99 } });
```

### Python

```python
from orca_runtime_python import parse_orca_auto, OrcaMachine, EventBus

def_ = parse_orca_auto(source)
bus = EventBus()
machine = OrcaMachine(def_, bus)

@machine.register_action('send_authorization_request')
async def send_auth(ctx, event):
    return {**ctx, 'payment_token': 'tok_123'}

await machine.start()
await machine.send({'type': 'submit_payment', 'payload': {'order_id': 'ord_1', 'amount': 99.99}})
```

### Go

```go
import "orca-runtime-go/orca_runtime_go"

def, _ := orca_runtime_go.ParseOrcaAuto(source)
bus := orca_runtime_go.NewEventBus()
machine := orca_runtime_go.NewOrcaMachine(def, bus, nil, nil)

machine.RegisterAction("send_authorization_request", func(ctx map[string]any, event orca_runtime_go.Event) map[string]any {
    ctx["payment_token"] = "tok_123"
    return ctx
})

machine.Start()
machine.Send(orca_runtime_go.Event{Type: "submit_payment"})
```

---

## Running the demos

```bash
# Text adventure (TypeScript) — interactive CLI
cd packages/demo-ts && pnpm run cli

# Smoke test (non-interactive)
pnpm test:demo-ts

# Agent framework (Python)
pnpm run test:demo-python

# Ride-hailing coordinator (Go) — runs FareSettlement end-to-end
pnpm run test:demo-go
# With snapshot/resume:
cd packages/demo-go && ./trip --resume

# nanoGPT training orchestrator (Python, no torch required for tests)
pnpm run test:demo-nanolab
```

---

## Running tests

```bash
# All TypeScript packages
pnpm test

# Core language only
pnpm test:lang

# Go runtime
cd packages/runtime-go && go test ./...

# Python runtime
cd packages/orca-lang && ../../.venv/bin/python -m pytest ../runtime-python/tests/ -v

# nanolab tests
pnpm run test:demo-nanolab
```

**Test counts:** 135 orca-lang · 63 runtime-ts · 69 runtime-python · 16 runtime-go · 47 demo-nanolab

---

## Examples

All in `packages/orca-lang/examples/`:

| File | Description |
|------|-------------|
| `simple-toggle.orca.md` | Minimal 2-state machine |
| `payment-processor.orca.md` | Guards, retries, effects |
| `text-adventure.orca.md` | Multi-state game engine |
| `hierarchical-game.orca.md` | Nested compound states |
| `parallel-order.orca.md` | Parallel regions with sync |
| `payment-with-properties.orca.md` | Bounded model checking properties |
