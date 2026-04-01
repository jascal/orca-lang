"""Decision Table Evaluator for Order Fulfillment Routing.

This module implements a simple decision table evaluator that can be called
from Orca machine action handlers. It evaluates input conditions against
a set of rules and returns the first matching result.

Decision Table: OrderRouting
Conditions:
  - order_value: enum (low, medium, high)
  - customer_tier: enum (standard, premium, vip)
  - item_category: enum (standard, fragile, hazmat)
  - destination: enum (domestic, international)

Actions:
  - shipping_tier: enum (standard, express, priority)
  - warehouse: enum (east, west, central)
  - fraud_check_level: enum (none, standard, enhanced)

Rules (first-match policy):
  order_value  | customer_tier | item_category | destination -> shipping_tier | warehouse | fraud_check_level
  low          | standard      | standard      | domestic    -> standard       | east      | none
  low          | standard      | standard      | international -> standard    | west      | standard
  low          | premium       | standard      | domestic    -> express        | east      | standard
  low          | premium       | standard      | international -> express     | west      | standard
  low          | vip           | standard      | -           -> express        | central   | none
  medium       | standard      | standard      | domestic    -> express        | east      | standard
  medium       | standard      | fragile       | -           -> priority       | west      | standard
  medium       | premium       | -             | -           -> priority       | central   | standard
  medium       | vip           | -             | -           -> priority       | central   | none
  high         | standard      | -             | -           -> priority       | east      | enhanced
  high         | premium       | -             | -           -> priority       | central   | enhanced
  high         | vip           | -             | -           -> priority       | central   | standard
  -            | -             | hazmat        | -           -> standard       | west      | enhanced
"""

from dataclasses import dataclass
from typing import Optional


@dataclass
class RoutingDecision:
    shipping_tier: str
    warehouse: str
    fraud_check_level: str


def _classify_order_value(value: float) -> str:
    """Classify order value into tier."""
    if value < 100:
        return "low"
    elif value < 500:
        return "medium"
    return "high"


def _matches_condition(condition_value: str, input_value: str) -> bool:
    """Check if an input value matches a condition (handles wildcard '-')."""
    if condition_value == "-":
        return True
    return condition_value == input_value


def evaluate_order_routing(
    order_value: float,
    customer_tier: str,
    item_category: str,
    destination: str,
) -> RoutingDecision:
    """
    Evaluate the order routing decision table.

    Returns a RoutingDecision with shipping_tier, warehouse, and fraud_check_level.
    """
    # Classify order value
    value_tier = _classify_order_value(order_value)

    # Rules: (order_value, customer_tier, item_category, destination, result)
    rules = [
        # Low value rules
        ("low", "standard", "standard", "domestic", RoutingDecision("standard", "east", "none")),
        ("low", "standard", "standard", "international", RoutingDecision("standard", "west", "standard")),
        ("low", "premium", "standard", "domestic", RoutingDecision("express", "east", "standard")),
        ("low", "premium", "standard", "international", RoutingDecision("express", "west", "standard")),
        ("low", "vip", "standard", "-", RoutingDecision("express", "central", "none")),
        # Medium value rules
        ("medium", "standard", "standard", "domestic", RoutingDecision("express", "east", "standard")),
        ("medium", "standard", "fragile", "-", RoutingDecision("priority", "west", "standard")),
        ("medium", "premium", "-", "-", RoutingDecision("priority", "central", "standard")),
        ("medium", "vip", "-", "-", RoutingDecision("priority", "central", "none")),
        # High value rules
        ("high", "standard", "-", "-", RoutingDecision("priority", "east", "enhanced")),
        ("high", "premium", "-", "-", RoutingDecision("priority", "central", "enhanced")),
        ("high", "vip", "-", "-", RoutingDecision("priority", "central", "standard")),
        # Hazmat rule (applies to any value)
        ("-", "-", "hazmat", "-", RoutingDecision("standard", "west", "enhanced")),
    ]

    for rule in rules:
        cond_value, cond_tier, cond_category, cond_dest, decision = rule
        if (
            _matches_condition(cond_value, value_tier)
            and _matches_condition(cond_tier, customer_tier)
            and _matches_condition(cond_category, item_category)
            and _matches_condition(cond_dest, destination)
        ):
            return decision

    # Default: if no rule matches, return safe defaults
    return RoutingDecision("standard", "east", "standard")


# ── Demo ───────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    test_cases = [
        # (order_value, customer_tier, item_category, destination)
        (50.00, "standard", "standard", "domestic"),
        (75.00, "vip", "standard", "international"),
        (250.00, "premium", "fragile", "domestic"),
        (750.00, "standard", "standard", "domestic"),
        (1200.00, "vip", "standard", "international"),
        (80.00, "standard", "hazmat", "domestic"),
        (600.00, "premium", "standard", "domestic"),
    ]

    print("Order Routing Decision Table Evaluator")
    print("=" * 60)
    for value, tier, category, dest in test_cases:
        result = evaluate_order_routing(value, tier, category, dest)
        print(f"\nInput: value=${value}, tier={tier}, category={category}, dest={dest}")
        print(f"  -> shipping={result.shipping_tier}, warehouse={result.warehouse}, fraud={result.fraud_check_level}")
