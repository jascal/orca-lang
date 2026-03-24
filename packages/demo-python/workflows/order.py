"""Order Processing Workflow - Demonstrates Orca state machine with event bus."""

import asyncio
from typing import Dict, Any

from bus import DomainEvent, EventType, get_event_bus
from bus.decorators import on_event
from orca import parse_orca, OrcaMachine
from orca.types import Context, Event as OrcaEvent


# Orca machine definition for order processing
ORDER_PROCESSOR_ORCA = """
machine OrderProcessor

context {
    order_id: ""
    customer_id: ""
    total: 0
    status: "pending"
    items: []
}

state pending [initial] "Order received, awaiting validation"
  on ORDER_PLACED -> validating

state validating "Validating order details"
  on VALIDATED -> payment_pending
  on REJECTED -> rejected

state payment_pending "Awaiting payment"
  on PAYMENT_INITIATED -> processing
  on PAYMENT_FAILED -> payment_failed

state processing "Processing order"
  on PROCESSED -> fulfilled

state fulfilled "Order ready for shipping"
  on SHIPPED -> shipped

state shipped "Order shipped"
  on DELIVERED -> delivered

state delivered [final] "Order completed"

state rejected [final] "Order rejected"

state payment_failed "Payment failed, awaiting retry"
  on RETRY_PAYMENT -> payment_pending
  on CANCEL -> rejected
"""


def create_order_processor() -> OrcaMachine:
    """Create an order processing state machine."""
    definition = parse_orca(ORDER_PROCESSOR_ORCA)

    # Action handlers
    def validate_order(ctx: Context, event: OrcaEvent):
        order_id = event.data.get("order_id", "unknown")
        ctx.set("order_id", order_id)
        ctx.set("customer_id", event.data.get("customer_id", ""))
        ctx.set("total", event.data.get("total", 0))
        ctx.set("items", event.data.get("items", []))
        ctx.set("status", "validating")
        print(f"[OrderProcessor] Order {order_id} validated")

    def initiate_payment(ctx: Context, event: OrcaEvent):
        ctx.set("status", "payment_pending")
        print(f"[OrderProcessor] Payment initiated for order {ctx.get('order_id')}")

    handlers = {
        "validate_order": validate_order,
        "initiate_payment": initiate_payment,
    }

    return OrcaMachine(definition, event_handlers=handlers)


async def process_order(order_data: Dict[str, Any], event_bus=None):
    """Process an order through the state machine."""
    if event_bus is None:
        event_bus = get_event_bus()

    machine = create_order_processor()
    machine.start()

    # Simulate order lifecycle via events
    events_to_send = [
        OrcaEvent("ORDER_PLACED", order_data),
        OrcaEvent("VALIDATED", {}),
        OrcaEvent("PAYMENT_INITIATED", {}),
        OrcaEvent("PROCESSED", {}),
        OrcaEvent("SHIPPED", {}),
        OrcaEvent("DELIVERED", {}),
    ]

    for evt in events_to_send:
        await machine.send(evt)
        await asyncio.sleep(0.1)  # Small delay between events

    machine.stop()
    return machine.get_snapshot()
