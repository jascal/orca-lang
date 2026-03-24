# Agent Framework Orca

Event-driven state machine framework combining Orca state machines with agent_framework's event bus pattern.

## Overview

This project demonstrates how to combine:
- **Orca state machines** - Declarative workflow orchestration with a simple state machine DSL
- **Agent Framework event bus** - Decoupled pub/sub communication between components

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Agent Framework Orca                     │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐   │
│  │   EventBus  │────▶│ OrcaMachine │────▶│  Workflow   │   │
│  │  (pub/sub)  │◀────│  (states)   │◀────│  Handlers   │   │
│  └─────────────┘     └─────────────┘     └─────────────┘   │
│         │                   │                               │
│         ▼                   ▼                               │
│  ┌─────────────┐     ┌─────────────┐                       │
│  │  DomainEvent│     │  Context    │                       │
│  │  (typed)    │     │  (state)    │                       │
│  └─────────────┘     └─────────────┘                       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Components

### Event Bus (`bus/`)

Inspired by agent_framework's event bus:
- `DomainEvent` - Typed event with correlation IDs, timestamps, source tracking
- `EventBus` - Pub/sub with async support
- `request/respond` - Decoupled request/response pattern

### Orca State Machine (`orca/`)

Lightweight state machine implementation:
- `OrcaMachine` - Event-driven state machine runtime
- `parse_orca()` - Parse Orca DSL text to machine definition
- `Context` - Mutable state container

### Runtime Packages

For production use, consider the standalone runtime packages:

- **[orca_runtime_python](https://github.com/orca-lang/orca-runtime-python)** - First-class Python async runtime with event bus
- **[orca_runtime_ts](https://github.com/orca-lang/orca-runtime-ts)** - First-class TypeScript async runtime

These packages provide:
- Async event bus with pub/sub and request/response patterns
- Hierarchical state support
- Effect handlers for async operations
- Parser for Orca DSL

This project's `orca/` module provides a simplified implementation for demonstration purposes.

### Workflows (`workflows/`)

Demo workflows:
- `OrderProcessor` - Order lifecycle management
- `AgentSupervisor` - Multi-agent task coordination

## Orca DSL Syntax

```orca
machine OrderProcessor

context {
    order_id: ""
    status: "pending"
}

state pending [initial] "Order received"
  on ORDER_PLACED -> validating

state validating "Validating order"
  on VALIDATED -> payment_pending
  on REJECTED -> rejected

state payment_pending "Awaiting payment"
  on PAYMENT_INITIATED -> processing

state processing "Processing order"
  on PROCESSED -> fulfilled

state fulfilled [final] "Order complete"

state rejected [final] "Order rejected"
```

## Usage

```python
import asyncio
from bus import get_event_bus
from orca import parse_orca, OrcaMachine, Event

# Create machine from Orca text
definition = parse_orca(orca_source)
machine = OrcaMachine(definition)

# Start and send events
machine.start()
await machine.send(Event("ORDER_PLACED", {"order_id": "123"}))
print(machine.state)  # "validating"

# Events published to shared bus
event_bus = get_event_bus()
# Subscribe to workflow state changes
event_bus.subscribe(EventType.WORKFLOW_STATE_CHANGED, handler)
```

## Running Demos

```bash
python3 demo.py
```

Demos:
1. Order Processing - Full order lifecycle with state transitions
2. Multi-Agent Task Orchestration - Concurrent agent processing
3. Event Bus Request/Response - Decoupled query pattern
4. Parsed Orca Machine - Machine created from text DSL

## Key Design Decisions

1. **Event-driven transitions** - State changes are events on the bus
2. **Async by default** - All bus operations are async
3. **Typed events** - EventType enum for type-safe event routing
4. **Separation of concerns** - Bus handles messaging, Machine handles logic
