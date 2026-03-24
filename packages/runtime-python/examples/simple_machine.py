"""
Simple example of using Orca Runtime Python.

This example demonstrates:
- Parsing an Orca machine definition
- Creating an OrcaMachine instance
- Sending events to transition states
- Subscribing to state change events
"""

import asyncio
from orca_runtime_python import (
    parse_orca,
    OrcaMachine,
    get_event_bus,
    Event,
    EventType,
    Effect,
    EffectResult,
)


# Define an Orca machine
ORDER_PROCESSOR_ORCA = """
machine OrderProcessor

context {
    order_id: ""
    status: "pending"
    amount: int = 0
}

events {
    ORDER_PLACED
    PAYMENT_RECEIVED
    ORDER_SHIPPED
    ORDER_DELIVERED
    ORDER_CANCELLED
}

state pending [initial] {
    description: "Order received, awaiting payment"
}

state paid {
    description: "Payment received, awaiting shipment"
}

state shipped {
    description: "Order shipped, in transit"
}

state delivered [final] {
    description: "Order delivered successfully"
}

state cancelled [final] {
    description: "Order was cancelled"
}

guards {
    valid_order: ctx.order_id != ""
    can_ship: ctx.amount > 0
}

transitions {
    pending + PAYMENT_RECEIVED -> paid : process_payment
    pending + ORDER_CANCELLED -> cancelled : cancel_order

    paid + ORDER_SHIPPED -> shipped : ship_order
    paid + ORDER_CANCELLED -> cancelled : refund_payment

    shipped + ORDER_DELIVERED -> delivered : mark_delivered
}

actions {
    process_payment: (ctx: Context) -> Context
    cancel_order: (ctx: Context) -> Context
    ship_order: (ctx: Context) -> Context
    refund_payment: (ctx: Context) -> Context
    mark_delivered: (ctx: Context) -> Context
}
"""


async def handle_effect(effect: Effect) -> EffectResult:
    """Simple effect handler that just logs and returns success."""
    print(f"  [Effect] {effect.type} executed with payload: {effect.payload}")
    return EffectResult(
        status="success",
        data={"processed": True, "effect": effect.type}
    )


async def main():
    print("=== Orca Runtime Python Demo ===\n")

    # Parse the Orca machine definition
    print("Parsing Orca source...")
    machine_def = parse_orca(ORDER_PROCESSOR_ORCA)
    print(f"  Machine: {machine_def.name}")
    print(f"  States: {[s.name for s in machine_def.states]}")
    print(f"  Events: {machine_def.events}")
    print(f"  Transitions: {len(machine_def.transitions)}")
    print()

    # Get the event bus
    bus = get_event_bus()

    # Subscribe to state changes
    async def on_state_change(event: Event):
        payload = event.payload
        print(f"  [State Change] {payload.get('from', '?')} -> {payload.get('to', '?')}")

    bus.subscribe(EventType.STATE_CHANGED, on_state_change)
    bus.subscribe(EventType.TRANSITION_STARTED, on_state_change)

    # Register effect handlers
    bus.register_effect_handler("Effect", handle_effect)
    for action in machine_def.actions:
        if action.has_effect:
            print(f"  Registering handler for effect type: {action.effect_type}")
            # In real usage, you'd register actual handlers here

    # Create the machine
    print("\nCreating OrcaMachine...")
    machine = OrcaMachine(
        definition=machine_def,
        context={"order_id": "ORD-123", "status": "pending", "amount": 99}
    )

    # Start the machine
    print("\nStarting machine...")
    await machine.start()
    print(f"  Initial state: {machine.state}")

    # Send events to transition through states
    print("\nSending events...")
    print()

    print("1. Sending PAYMENT_RECEIVED...")
    await machine.send("PAYMENT_RECEIVED")
    print(f"   State: {machine.state}")

    print("\n2. Sending ORDER_SHIPPED...")
    await machine.send("ORDER_SHIPPED")
    print(f"   State: {machine.state}")

    print("\n3. Sending ORDER_DELIVERED...")
    await machine.send("ORDER_DELIVERED")
    print(f"   State: {machine.state}")

    # Check if machine reached a final state
    if machine.state.leaf() in ("delivered", "cancelled"):
        print(f"\n  Machine reached final state: {machine.state}")

    # Stop the machine
    print("\nStopping machine...")
    await machine.stop()
    print(f"  Machine active: {machine.is_active}")

    print("\n=== Demo Complete ===")


if __name__ == "__main__":
    asyncio.run(main())
