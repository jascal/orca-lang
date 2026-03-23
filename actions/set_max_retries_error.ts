```typescript
function set_max_retries_error(ctx: Context): Context {
  return {
    ...ctx,
    error_message: `Maximum retries (${ctx.retry_count}) exceeded for order ${ctx.order_id}`,
  };
}
```