```typescript
function set_timeout_error(ctx: Context): Context {
  return {
    ...ctx,
    error_message: "Payment request timed out"
  };
}
```