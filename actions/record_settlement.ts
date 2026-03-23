```typescript
function record_settlement(ctx: {
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
  return {
    ...ctx,
    error_message: "",
  };
}
```