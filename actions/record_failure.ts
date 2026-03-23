```typescript
function record_failure(ctx: {
  order_id: string;
  amount: number;
  currency: string;
  retry_count: number;
  payment_token: string | null;
  error_message: string | null;
}): {
  order_id: string;
  amount: number;
  currency: string;
  retry_count: number;
  payment_token: string | null;
  error_message: string | null;
} {
  return {
    ...ctx,
    retry_count: ctx.retry_count + 1,
    error_message: ctx.error_message ?? "Payment failed",
  };
}
```