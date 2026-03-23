```typescript
function initialize_payment(ctx: Context, event: { order_id: string; amount: number; currency: string; payment_token: string }): Context {
  return {
    ...ctx,
    order_id: event.order_id,
    amount: event.amount,
    currency: event.currency,
    payment_token: event.payment_token,
    retry_count: 0,
    error_message: null,
  };
}
```