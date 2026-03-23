```typescript
record_auth_code(ctx: Context, event: Event): Context {
  return {
    ...ctx,
    payment_token: event.auth_code ?? event.payment_token ?? ctx.payment_token,
  };
}
```