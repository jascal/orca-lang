```typescript
function increment_retry(ctx: Context): Context {
  return {
    ...ctx,
    retry_count: ctx.retry_count + 1,
  };
}
```