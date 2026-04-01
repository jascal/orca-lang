# machine OrderProcessor

## context

| Field | Type | Default |
|-------|------|---------|
| order_id | string | "" |
| customer_id | string | "" |
| total | number | 0 |
| status | string | "pending" |
| items | list | [] |

## events

- ORDER_PLACED
- VALIDATED
- REJECTED
- PAYMENT_INITIATED
- PAYMENT_FAILED
- PROCESSED
- SHIPPED
- DELIVERED
- RETRY_PAYMENT
- CANCEL

## state received [initial] "Order received, awaiting validation"
> on ORDER_PLACED -> validating

## state validating "Validating order details"
> on VALIDATED -> payment_pending
> on REJECTED -> rejected

## state payment_pending "Awaiting payment"
> on PAYMENT_INITIATED -> processing
> on PAYMENT_FAILED -> payment_failed

## state processing "Processing order"
> on PROCESSED -> fulfilled

## state fulfilled "Order ready for shipping"
> on SHIPPED -> shipped

## state shipped "Order shipped"
> on DELIVERED -> delivered

## state delivered [final] "Order completed"

## state rejected [final] "Order rejected"

## state payment_failed "Payment failed, awaiting retry"
> on RETRY_PAYMENT -> payment_pending
> on CANCEL -> rejected

## transitions

| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| received | ORDER_PLACED | | validating | |
| validating | VALIDATED | | payment_pending | |
| validating | REJECTED | | rejected | |
| payment_pending | PAYMENT_INITIATED | | processing | |
| payment_pending | PAYMENT_FAILED | | payment_failed | |
| processing | PROCESSED | | fulfilled | |
| fulfilled | SHIPPED | | shipped | |
| shipped | DELIVERED | | delivered | |
| payment_failed | RETRY_PAYMENT | | payment_pending | |
| payment_failed | CANCEL | | rejected | |

---

# machine AgentSupervisor

## context

| Field | Type | Default |
|-------|------|---------|
| task_id | string | "" |
| agent_id | string | "" |
| status | string | "idle" |
| result | string | "" |
| subtasks | list | [] |
| completed_subtasks | list | [] |

## events

- TASK_ASSIGNED
- SUBTASK_CREATED
- SUBTASK_COMPLETED
- ALL_SUBTASKS_COMPLETE
- TASK_FAILED

## state idle [initial] "Agent ready for tasks"
> on TASK_ASSIGNED -> working

## state working "Agent processing task"
> on SUBTASK_CREATED -> working
> on SUBTASK_COMPLETED -> working
> on ALL_SUBTASKS_COMPLETE -> success
> on TASK_FAILED -> failed

## state success [final] "Task completed successfully"

## state failed [final] "Task failed"

## transitions

| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| idle | TASK_ASSIGNED | | working | |
| working | SUBTASK_CREATED | | working | |
| working | SUBTASK_COMPLETED | | working | |
| working | ALL_SUBTASKS_COMPLETE | | success | |
| working | TASK_FAILED | | failed | |

---

# machine PaymentProcessor

## context

| Field | Type | Default |
|-------|------|---------|
| amount | number | 0 |

## events

- PROCESS
- SUCCESS
- FAILURE

## state pending [initial] "Payment pending"
> on PROCESS -> processing

## state processing "Processing payment"
> on SUCCESS -> completed
> on FAILURE -> failed

## state completed [final] "Payment successful"

## state failed [final] "Payment failed"

## transitions

| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| pending | PROCESS | | processing | |
| processing | SUCCESS | | completed | |
| processing | FAILURE | | failed | |

---

# machine OrderFulfillment

## context

| Field | Type | Default |
|-------|------|---------|
| order_id | string | "" |
| customer_id | string | "" |
| customer_tier | string | "standard" |
| total | number | 0 |
| items | list | [] |
| destination | string | "domestic" |
| item_category | string | "standard" |
| status | string | "pending" |
| shipping_tier | string | "" |
| warehouse | string | "" |
| fraud_check_level | string | "" |
| tracking | string | "" |
| rejection_reason | string | "" |

## events

- ORDER_RECEIVED
- VALIDATED
- ROUTED
- REJECTED
- FULFILLMENT_COMPLETE
- SHIPPED
- DELIVERED

## state received [initial] "Order received, awaiting validation"
> on ORDER_RECEIVED -> validated

## state validated "Validating order details"
> on VALIDATED -> routed
> on REJECTED -> rejected

## state routed "Routing order using decision table"
> on ROUTED -> fulfillment

## state fulfillment "Processing order for shipment"
> on FULFILLMENT_COMPLETE -> shipped

## state shipped "Order shipped"
> on SHIPPED -> delivered

## state delivered [final] "Order delivered successfully"

## state rejected [final] "Order rejected"

## transitions

| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| received | ORDER_RECEIVED | | validated | |
| validated | VALIDATED | | routed | |
| validated | REJECTED | | rejected | |
| routed | ROUTED | | fulfillment | |
| fulfillment | FULFILLMENT_COMPLETE | | shipped | |
| shipped | SHIPPED | | delivered | |

---

## OrderRouting Decision Table

The `route_order` action evaluates these rules to determine routing:

| order_value | customer_tier | item_category | destination | → shipping_tier | → warehouse | → fraud_check_level |
|-------------|---------------|---------------|-------------|-----------------|-------------|---------------------|
| low | standard | standard | domestic | standard | east | none |
| low | standard | standard | international | standard | west | standard |
| low | premium | standard | domestic | express | east | standard |
| low | premium | standard | international | express | west | standard |
| low | vip | standard | - | express | central | none |
| medium | standard | standard | domestic | express | east | standard |
| medium | standard | fragile | - | priority | west | standard |
| medium | premium | - | - | priority | central | standard |
| medium | vip | - | - | priority | central | none |
| high | standard | - | - | priority | east | enhanced |
| high | premium | - | - | priority | central | enhanced |
| high | vip | - | - | priority | central | standard |
| - | - | hazmat | - | standard | west | enhanced |
