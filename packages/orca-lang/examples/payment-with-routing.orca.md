# machine PaymentProcessor

## context

| Field | Type | Default |
|-------|------|---------|
| amount_tier | enum | low, medium, high |
| customer_type | enum | new, returning, vip |
| has_fraud_flag | bool | false |
| gateway | enum | stripe, adyen, manual_review |
| requires_approval | bool | false |
| risk_level | enum | low, medium, high |

## events

- submit_payment
- payment_approved
- payment_declined
- route_decision

## state idle [initial]
- ignore: *

## state routing
- ignore: *

## state processing
- ignore: *

## state approved [final]
> Payment was approved

## state declined [final]
> Payment was declined

## transitions

| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| idle | submit_payment | | routing | calculate_amount_tier |
| routing | route_decision | | processing | apply_routing_decision |
| processing | payment_approved | | approved | mark_approved |
| processing | payment_declined | | declined | mark_declined |


## guards

| Name | Expression |
|------|------------|
| is_high_risk | `ctx.has_fraud_flag == true` |
| is_vip | `ctx.customer_type == 'vip'` |

## actions

| Name | Signature |
|------|-----------|
| calculate_amount_tier | `(ctx) -> Context` |
| apply_routing_decision | `(ctx) -> Context` |
| mark_approved | `(ctx) -> Context` |
| mark_declined | `(ctx) -> Context` |

---

# decision_table PaymentRouting

## conditions

| Name | Type | Values |
|------|------|--------|
| amount_tier | enum | low, medium, high |
| customer_type | enum | new, returning, vip |
| has_fraud_flag | bool | |

## actions

| Name | Type | Values |
|------|------|--------|
| gateway | enum | stripe, adyen, manual_review |
| requires_approval | bool | |
| risk_level | enum | low, medium, high |

## rules

| amount_tier | customer_type | has_fraud_flag | → gateway | → requires_approval | → risk_level |
|-------------|---------------|----------------|-----------|---------------------|--------------|
| high | - | true | manual_review | true | high |
| high | vip | false | stripe | false | low |
| high | returning | false | adyen | false | medium |
| high | new | false | manual_review | true | medium |
| medium | - | - | stripe | false | low |
| low | - | - | stripe | false | low |
| low | vip | false | stripe | false | low |
