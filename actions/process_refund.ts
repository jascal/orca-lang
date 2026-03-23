

```typescript
import { Context, Effect } from './types';

interface RefundRequest {
  order_id: string;
  amount: number;
  currency: string;
  payment_token: string;
}

function process_refund(ctx: Context): [Context, Effect<RefundRequest>] {
  const newContext: Context = {
    ...ctx,
    // Reset retry count when initiating a refund
    retry_count: 0,
    error_message: null,
  };

  const effect: Effect<RefundRequest> = {
    type: 'RefundRequest',
    data: {
      order_id: ctx.order_id,
      amount: ctx.amount,
      currency: ctx.currency,
      payment_token: ctx.payment_token,
    },
  };

  return [newContext, effect];
}

export { process_refund };
```