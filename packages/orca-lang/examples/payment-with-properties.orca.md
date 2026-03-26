# machine PaymentWithProperties

## context

| Field         | Type    | Default |
|---------------|---------|---------|
| order_id      | string  |         |
| amount        | decimal |         |
| currency      | string  |         |
| retry_count   | int     | 0       |
| payment_token | string? |         |
| error_message | string? |         |

## events

- submit_payment
- payment_authorized
- payment_declined
- payment_timeout
- retry_requested
- cancel_requested
- refund_requested
- settlement_confirmed

## state idle [initial]
> Waiting for a payment submission
- on_entry: reset_context

## state validating
> Validating payment details before authorization
- on_entry: validate_payment_details

## state authorizing
> Waiting for payment gateway response
- on_entry: send_authorization_request

## state authorized
> Payment authorized, awaiting settlement
- on_entry: log_authorization

## state declined
> Payment was declined by the gateway
- on_entry: format_decline_reason

## state failed [final]
> Terminal failure state
- on_entry: record_failure

## state settled [final]
> Payment fully settled
- on_entry: record_settlement

## transitions

| Source      | Event                | Guard      | Target      | Action                |
|-------------|----------------------|------------|-------------|-----------------------|
| idle        | submit_payment       |            | validating  | initialize_payment    |
| validating  | payment_authorized   |            | authorizing | prepare_auth_request  |
| validating  | payment_declined     |            | declined    |                       |
| authorizing | payment_authorized   |            | authorized  | record_auth_code      |
| authorizing | payment_declined     |            | declined    | increment_retry       |
| authorizing | payment_timeout      |            | declined    | set_timeout_error     |
| declined    | retry_requested      | can_retry  | validating  | increment_retry       |
| declined    | retry_requested      | !can_retry | failed      | set_max_retries_error |
| declined    | cancel_requested     |            | failed      |                       |
| authorized  | settlement_confirmed |            | settled     |                       |
| authorized  | refund_requested     |            | failed      | process_refund        |

## guards

| Name            | Expression                  |
|-----------------|-----------------------------|
| can_retry       | `ctx.retry_count < 3`       |
| has_valid_token | `ctx.payment_token != null` |

## actions

| Name                       | Signature                                  |
|----------------------------|--------------------------------------------|
| reset_context              | `() -> Context`                            |
| initialize_payment         | `(ctx, event) -> Context`                  |
| validate_payment_details   | `(ctx) -> Context`                         |
| send_authorization_request | `(ctx) -> Context + Effect<AuthRequest>`   |
| prepare_auth_request       | `(ctx) -> Context`                         |
| record_auth_code           | `(ctx, event) -> Context`                  |
| increment_retry            | `(ctx) -> Context`                         |
| set_timeout_error          | `(ctx) -> Context`                         |
| set_max_retries_error      | `(ctx) -> Context`                         |
| format_decline_reason      | `(ctx, event) -> Context`                  |
| process_refund             | `(ctx) -> Context + Effect<RefundRequest>` |
| record_failure             | `(ctx) -> Context`                         |
| log_authorization          | `(ctx) -> Context`                         |
| record_settlement          | `(ctx) -> Context`                         |

## properties

- passes_through: authorized for idle -> settled
- unreachable: settled from failed
- reachable: authorized from idle
- live
- responds: settled from idle within 5
- invariant: `ctx.retry_count <= 3`
