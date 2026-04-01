"""Agent Framework Orca Demo - Event-driven state machines.

Demonstrates combining:
- Orca state machines (from smgl) for workflow orchestration
- Agent Framework event bus for decoupled communication
- Python async/await for concurrent processing
"""

import asyncio
from pathlib import Path
from bus import get_event_bus, EventType, DomainEvent
from workflows.order import create_order_processor, process_order
from workflows.agent import create_agent_supervisor, run_agent_demo
from workflows.fulfillment import run_order_fulfillment_demo
from workflows.dt_evaluator import evaluate_order_routing, RoutingDecision
from orca import OrcaMachine, parse_orca_multi, Event as OrcaEvent


def _load_machines():
    """Load all machines from workflows.orca.md."""
    content = Path(__file__).parent / "workflows.orca.md"
    return parse_orca_multi(content.read_text())


async def demo_order_processor():
    """Demo 1: Order processing with Orca state machine."""
    print("\n" + "=" * 60)
    print("DEMO 1: ORDER PROCESSING STATE MACHINE")
    print("=" * 60 + "\n")

    machine = create_order_processor()
    machine.start()

    # Simulate order lifecycle
    order_events = [
        ("ORDER_PLACED", {"order_id": "ORD-001", "customer_id": "CUST-42", "total": 99.99}),
        ("VALIDATED", {}),
        ("PAYMENT_INITIATED", {}),
        ("PROCESSED", {}),
        ("SHIPPED", {}),
        ("DELIVERED", {}),
    ]

    for event_type, data in order_events:
        print(f"\n> Sending event: {event_type}")
        evt = OrcaEvent(event_type, data)
        await machine.send(evt)
        print(f"  Machine is now in state: {machine.state}")

        if machine.is_final_state():
            print(f"  Reached final state!")
            break

    machine.stop()

    # Show events published to bus
    event_bus = get_event_bus()
    print(f"\n> Events published to bus ({len(event_bus.event_store)} total):")
    for e in event_bus.event_store[-10:]:
        print(f"    {e.event_type.value}: {e.data}")


async def demo_agent_orchestration():
    """Demo 2: Multi-agent task orchestration."""
    print("\n" + "=" * 60)
    print("DEMO 2: MULTI-AGENT TASK ORCHESTRATION")
    print("=" * 60 + "\n")

    await run_agent_demo()


async def demo_event_bus_standalone():
    """Demo 3: Standalone event bus demonstration."""
    print("\n" + "=" * 60)
    print("DEMO 3: EVENT BUS REQUEST/RESPONSE")
    print("=" * 60 + "\n")

    event_bus = get_event_bus()

    # Register a response handler
    async def handle_query(event: DomainEvent):
        print(f"  [QueryHandler] Received query: {event.data}")
        await event_bus.respond(
            event,
            EventType.SCHEDULING_QUERY_RESPONSE,
            {"result": "Query processed", "data": [1, 2, 3]},
            "query_handler"
        )

    event_bus.subscribe(EventType.SCHEDULING_QUERY, handle_query)

    # Send a request and wait for response
    request = DomainEvent(
        event_type=EventType.SCHEDULING_QUERY,
        entity_id="query-1",
        entity_type="scheduling",
        data={"type": "availability", "date": "2026-03-25"},
        source_module="demo"
    )

    print("> Sending request and waiting for response...")
    response = await event_bus.request(
        request,
        EventType.SCHEDULING_QUERY_RESPONSE,
        timeout=2.0
    )

    if response:
        print(f"> Received response: {response.data}")
    else:
        print("> No response received (timeout)")


async def demo_custom_machine():
    """Demo 4: Custom machine parsed from Orca text."""
    print("\n" + "=" * 60)
    print("DEMO 4: PARSED ORCA MACHINE DEFINITION")
    print("=" * 60 + "\n")

    machines = _load_machines()
    # PaymentProcessor is 3rd machine (index 2)
    definition = machines[2]

    print(f"> Parsing Orca source from workflows.orca.md...")
    print(f"  Machine: {definition.name}")
    print(f"  States: {[s.name for s in definition.states]}")
    print(f"  Initial: {definition.initial_state}")

    machine = OrcaMachine(definition)
    machine.start()

    print(f"\n> Sending PROCESS event...")
    await machine.send(OrcaEvent("PROCESS", {"amount": 100}))
    print(f"  State: {machine.state}")

    print(f"\n> Sending SUCCESS event...")
    await machine.send(OrcaEvent("SUCCESS", {}))
    print(f"  State: {machine.state}")
    print(f"  Is final: {machine.is_final_state()}")


async def demo_decision_table_evaluator():
    """Demo 5: Decision Table Evaluator standalone."""
    print("\n" + "=" * 60)
    print("DEMO 5: DECISION TABLE - ORDER ROUTING")
    print("=" * 60 + "\n")

    test_cases = [
        # (order_value, customer_tier, item_category, destination, description)
        (50.00, "standard", "standard", "domestic", "Low-value domestic standard order"),
        (75.00, "vip", "standard", "international", "Low-value VIP international order"),
        (250.00, "premium", "fragile", "domestic", "Medium-value premium fragile order"),
        (750.00, "standard", "standard", "domestic", "High-value standard order"),
        (1200.00, "vip", "standard", "international", "High-value VIP international order"),
        (80.00, "standard", "hazmat", "domestic", "Hazmat item (triggers special handling)"),
        (600.00, "premium", "standard", "domestic", "High-value premium domestic order"),
    ]

    for value, tier, category, dest, description in test_cases:
        result = evaluate_order_routing(value, tier, category, dest)
        print(f"Case: {description}")
        print(f"  Input: value=${value}, tier={tier}, category={category}, dest={dest}")
        print(f"  -> {result.shipping_tier} shipping, warehouse={result.warehouse}, "
              f"fraud_check={result.fraud_check_level}")
        print()


async def demo_order_fulfillment():
    """Demo 6: Order Fulfillment with Decision Table routing."""
    await run_order_fulfillment_demo()


async def main():
    """Run all demos."""
    print("""
╔════════════════════════════════════════════════════════════╗
║     AGENT FRAMEWORK ORCA - EVENT-DRIVEN STATE MACHINES   ║
╚════════════════════════════════════════════════════════════╝

Combining Orca state machines with agent_framework event bus.
""")

    # Demo 1: Order processor
    await demo_order_processor()

    # Demo 2: Agent orchestration
    await demo_agent_orchestration()

    # Demo 3: Event bus request/response
    await demo_event_bus_standalone()

    # Demo 4: Custom parsed machine
    await demo_custom_machine()

    # Demo 5: Decision Table Evaluator
    await demo_decision_table_evaluator()

    # Demo 6: Order Fulfillment with Decision Table routing
    await demo_order_fulfillment()

    print("\n" + "=" * 60)
    print("ALL DEMOS COMPLETED")
    print("=" * 60 + "\n")


if __name__ == "__main__":
    asyncio.run(main())
