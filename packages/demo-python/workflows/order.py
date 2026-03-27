"""Order Processing Workflow - Demonstrates Orca state machine with event bus."""

import asyncio
import re
from pathlib import Path
from typing import Dict, Any

from bus import DomainEvent, EventType, get_event_bus
from bus.decorators import on_event
from orca import parse_orca, OrcaMachine
from orca.types import Context, Event as OrcaEvent


def _load_orca_from_markdown(machine_name: str) -> str:
    """Extract an Orca machine definition from workflows.orca.md."""
    workflows_file = Path(__file__).parent.parent / "workflows.orca.md"
    content = workflows_file.read_text()

    # Find the section for this machine
    pattern = rf"## {machine_name}\n(.*?)```orca\n(.*?)\n```"
    match = re.search(pattern, content, re.DOTALL)
    if match:
        return match.group(2)
    raise ValueError(f"Machine '{machine_name}' not found in workflows.orca.md")


# Load Orca machine definition from markdown
ORDER_PROCESSOR_ORCA = _load_orca_from_markdown("OrderProcessor")


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
