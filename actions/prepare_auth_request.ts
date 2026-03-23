```typescript
function prepare_auth_request(ctx: {
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
    error_message: null,
    retry_count: 0,
  };
}
```

This implementation:

1. **Clears the `error_message`** — When preparing a new authorization request, any previous error state should be reset so the new attempt starts clean.
2. **Resets `retry_count` to `0`** — A fresh authorization request should start with zero retries, as this is the beginning of a new payment authorization attempt.
3. **Preserves all other context fields** (`order_id`, `amount`, `currency`, `payment_token`) — These are the essential payment details needed for the authorization and should remain unchanged.