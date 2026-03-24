# Orca Runtime Python

A first-class Python async runtime for [Orca](https://github.com/orca-lang/orca-lang) state machines.

## Overview

Orca is a state machine language designed for LLM code generation. This package provides a Python runtime that executes Orca machine definitions with:

- **Async-first** - Native `async/await` throughout
- **Event bus integration** - Decoupled pub/sub for agentic systems
- **Effect system** - Typed async operations with handler registration
- **Hierarchical states** - Nested/compound state support

## Installation

```bash
pip install orca-runtime-python
```

## Quick Start

```python
import asyncio
from orca_runtime_python import (
    parse_orca,
    OrcaMachine,
    get_event_bus,
)

# Define an Orca machine
orca_source = """
machine OrderProcessor

context {
    order_id: ""
    status: "pending"
}

state pending [initial] "Order received"
state fulfilled [final] "Order complete"

transitions {
    pending + ORDER_PLACED -> pending
    pending + ORDER_FULFILLED -> fulfilled
}
"""

async def main():
    # Parse and create machine
    machine_def = parse_orca(orca_source)
    machine = OrcaMachine(machine_def)

    # Register effect handlers
    bus = get_event_bus()
    bus.register_effect_handler("Effect", lambda e: EffectResult(
        status="success", data=e.payload
    ))

    # Start and run
    await machine.start()
    print(f"Initial state: {machine.state}")

    await machine.send("ORDER_FULFILLED")
    print(f"After event: {machine.state}")

    await machine.stop()

asyncio.run(main())
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        OrcaMachine                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ State Store  │  │ Transition   │  │ Effect Executor      │  │
│  │ (current)    │  │ Evaluator    │  │ (async handlers)     │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
│          │                │                      │               │
│          └────────────────┼──────────────────────┘               │
│                           ▼                                      │
│                  ┌──────────────────┐                           │
│                  │   EventBus       │  (pub/sub)                 │
│                  └──────────────────┘                           │
└─────────────────────────────────────────────────────────────────┘
```

## Core Components

### OrcaMachine

The main runtime class that executes state machines:

```python
machine = OrcaMachine(
    definition=machine_def,
    event_bus=get_event_bus(),
    context={"order_id": "123"},
    on_transition=lambda old, new: print(f"{old} -> {new}"),
)
```

### EventBus

Async event bus with pub/sub and request/response:

```python
bus = get_event_bus()

# Subscribe to events
bus.subscribe(EventType.STATE_CHANGED, handler)

# Publish events
await bus.publish(Event(
    type=EventType.STATE_CHANGED,
    source="OrderProcessor",
    payload={"from": "pending", "to": "fulfilled"},
))

# Request/response pattern
response = await bus.request_response(
    request_type=EventType.SCHEDULING_QUERY,
    request_payload={"type": "availability"},
    response_type=EventType.SCHEDULING_QUERY_RESPONSE,
)
```

### Effect Handlers

Register async handlers for effect types:

```python
async def handle_narrative(effect: Effect) -> EffectResult:
    narrative = await generate_narrative(effect.payload)
    return EffectResult(status="success", data={"narrative": narrative})

bus.register_effect_handler("NarrativeRequest", handle_narrative)
```

## Orca DSL Syntax

```orca
machine GameEngine

context {
    health: int = 100
    inventory: string[]
}

events {
    start_game
    attack
    heal
}

state idle [initial] {
    description: "Waiting for player input"
}

state combat {
    description: "In combat"

    state fighting [initial] {
        description: "Actively fighting"
    }

    state defending {
        description: "Blocking attacks"
    }
}

state game_over [final] {
    description: "Game ended"
}

guards {
    can_heal: ctx.health < 100
}

transitions {
    idle + start_game -> combat : start_combat
    combat + attack -> combat : resolve_attack
    combat + heal [can_heal] -> combat : apply_heal
    combat + attack [health <= 0] -> game_over : end_game
}

actions {
    start_combat: (ctx: Context) -> Context
    resolve_attack: (ctx: Context) -> Context + Effect<DamageRequest>
    apply_heal: (ctx: Context) -> Context
    end_game: (ctx: Context) -> Context
}
```

## Hierarchy

```
orca-runtime-python/
├── orca_runtime_python/    # Main package
│   ├── __init__.py
│   ├── types.py            # Core types
│   ├── parser.py           # DSL parser
│   ├── machine.py          # OrcaMachine runtime
│   ├── bus.py              # EventBus
│   └── effects.py          # Effect system
├── pyproject.toml
└── README.md
```

## Relationship to Other Implementations

| Package | Language | Purpose |
|---------|----------|---------|
| `orca` (npm) | TypeScript/JS | Core implementation (parser, verifier, compiler) |
| `orca-runtime-python` | Python | Python async runtime |

The Orca language is defined once and implemented across platforms. The Python runtime executes machines compiled from Orca DSL.

## License

Apache 2.0
