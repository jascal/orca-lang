```typescript
function log_authorization(ctx: {
  order_id: string;
  amount: number;
  currency: string;
  retry_count: number;
  payment_token: string;
  error_message: string;
}): {
  order_id: string;
  amount: number;
  currency: string;
  retry_count: number;
  payment_token: string;
  error_message: string;
} {
  console.log(
    `[PaymentProcessor] Authorization logged - Order: ${ctx.order_id}, Amount: ${ctx.amount} ${ctx.currency}, Token: ${ctx.payment_token}, Retry Count: ${ctx.retry_count}${ctx.error_message ? `, Error: ${ctx.error_message}` : ""}`
  );

  return { ...ctx };
}
```