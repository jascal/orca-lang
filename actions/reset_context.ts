```typescript
function reset_context(context: Context): Context {
  return {
    order_id: null,
    amount: 0,
    currency: "USD",
    retry_count: 0,
    payment_token: null,
    error_message: null,
  };
}
```