"""Order Fulfillment Workflow - Demonstrates Orca state machine with Decision Table routing.

This workflow shows how decision tables can be used within a state machine
to handle conditional routing logic. The 'routed' state uses a decision
table to determine shipping tier, warehouse assignment, and fraud check
level based on order characteristics.
"""

from pathlib import Path

from orca import parse_orca_multi, OrcaMachine
from orca.types import Context, Event as OrcaEvent


def _load_machines():
    """Load all machines from workflows.orca.md."""
    content = Path(__file__).parent.parent / "workflows.orca.md"
    return parse_orca_multi(content.read_text())


# Load machines once at module level
_MACHINES = _load_machines()


def create_order_fulfillment_machine() -> OrcaMachine:
    """Create an Order Fulfillment state machine."""
    # OrderFulfillment is 4th machine (index 3)
    definition = _MACHINES[3]

    # Action handlers
    def receive_order(ctx: Context, event: OrcaEvent):
        order_id = event.data.get("order_id", "unknown")
        customer_id = event.data.get("customer_id", "")
        total = event.data.get("total", 0.0)
        items = event.data.get("items", [])
        destination = event.data.get("destination", "domestic")
        customer_tier = event.data.get("customer_tier", "standard")
        item_category = event.data.get("item_category", "standard")

        ctx.set("order_id", order_id)
        ctx.set("customer_id", customer_id)
        ctx.set("total", float(total))
        ctx.set("items", items)
        ctx.set("destination", destination)
        ctx.set("customer_tier", customer_tier)
        ctx.set("item_category", item_category)
        ctx.set("status", "received")
        print(f"[OrderFulfillment] Received order {order_id}, total=${total}")

    def validate_order(ctx: Context, event: OrcaEvent):
        total = ctx.get("total", 0.0)
        items = ctx.get("items", [])
        if total > 0 and len(items) > 0:
            ctx.set("status", "validated")
            print(f"[OrderFulfillment] Order {ctx.get('order_id')} validated")
        else:
            ctx.set("status", "rejected")
            print(f"[OrderFulfillment] Order {ctx.get('order_id')} rejected: invalid order")

    def route_order(ctx: Context, event: OrcaEvent):
        """Route order using decision table evaluation."""
        from workflows.dt_evaluator import evaluate_order_routing

        order_value = ctx.get("total", 0.0)
        customer_tier = ctx.get("customer_tier", "standard")
        item_category = ctx.get("item_category", "standard")
        destination = ctx.get("destination", "domestic")

        decision = evaluate_order_routing(order_value, customer_tier, item_category, destination)

        ctx.set("shipping_tier", decision.shipping_tier)
        ctx.set("warehouse", decision.warehouse)
        ctx.set("fraud_check_level", decision.fraud_check_level)
        ctx.set("status", "routed")

        print(f"[OrderFulfillment] Routed: {decision.shipping_tier} shipping, "
              f"warehouse={decision.warehouse}, fraud={decision.fraud_check_level}")

    def process_fulfillment(ctx: Context, event: OrcaEvent):
        warehouse = ctx.get("warehouse", "east")
        shipping_tier = ctx.get("shipping_tier", "standard")
        ctx.set("status", "fulfilled")
        print(f"[OrderFulfillment] Fulfilled from {warehouse} warehouse, "
              f"{shipping_tier} shipping ready")

    def ship_order(ctx: Context, event: OrcaEvent):
        shipping_tier = ctx.get("shipping_tier", "standard")
        tracking = f"TRK-{ctx.get('order_id', 'UNKNOWN')}"
        ctx.set("tracking", tracking)
        ctx.set("status", "shipped")
        print(f"[OrderFulfillment] Shipped via {shipping_tier}, tracking={tracking}")

    def complete_order(ctx: Context, event: OrcaEvent):
        ctx.set("status", "completed")
        print(f"[OrderFulfillment] Order {ctx.get('order_id')} delivered!")

    def handle_rejection(ctx: Context, event: OrcaEvent):
        reason = event.data.get("reason", "unknown")
        ctx.set("status", "rejected")
        ctx.set("rejection_reason", reason)
        print(f"[OrderFulfillment] Order rejected: {reason}")

    handlers = {
        "receive_order": receive_order,
        "validate_order": validate_order,
        "route_order": route_order,
        "process_fulfillment": process_fulfillment,
        "ship_order": ship_order,
        "complete_order": complete_order,
        "handle_rejection": handle_rejection,
    }

    return OrcaMachine(definition, event_handlers=handlers)


async def run_order_fulfillment_demo():
    """Run the Order Fulfillment demo."""
    print("\n" + "=" * 60)
    print("ORDER FULFILLMENT WITH DECISION TABLE ROUTING")
    print("=" * 60 + "\n")

    machine = create_order_fulfillment_machine()
    machine.start()

    # Simulate a high-value VIP order with fragile items
    order_data = {
        "order_id": "ORD-2026-001",
        "customer_id": "VIP-999",
        "customer_tier": "vip",
        "total": 899.99,
        "item_category": "fragile",
        "destination": "domestic",
        "items": ["Crystal Vase", "Glass Sculpture"],
    }

    print(f"> Order: {order_data['order_id']}")
    print(f"  Customer: {order_data['customer_id']} ({order_data['customer_tier']})")
    print(f"  Total: ${order_data['total']}, Category: {order_data['item_category']}")
    print(f"  Destination: {order_data['destination']}\n")

    events = [
        OrcaEvent("ORDER_RECEIVED", order_data),
        OrcaEvent("VALIDATED", {}),
        OrcaEvent("ROUTED", {}),
        OrcaEvent("FULFILLMENT_COMPLETE", {}),
        OrcaEvent("SHIPPED", {}),
        OrcaEvent("DELIVERED", {}),
    ]

    for evt in events:
        print(f"> Event: {evt.type}")
        await machine.send(evt)
        snapshot = machine.get_snapshot()
        print(f"  State: {machine.state}")
        print(f"  Status: {snapshot.context_data.get('status', 'unknown')}")
        if machine.is_final_state():
            print(f"  *** FINAL STATE REACHED ***")
            break
        print()

    machine.stop()
