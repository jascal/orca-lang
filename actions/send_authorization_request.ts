

```typescript
import { Context, Effect } from './types';

interface AuthRequest {
  type: 'AuthRequest';
  order_id: string;
  amount: number;
  currency: string;
  payment_token: string;
}

function send_authorization_request(ctx: Context): [Context, Effect<AuthRequest>] {
  const effect: Effect<AuthRequest> = {
    type: 'AuthRequest',
    order_id: ctx.order_id,
    amount: ctx.amount,
    currency: ctx.currency,
    payment_token: ctx.payment_token,
  };

  const newContext: Context = {
    ...ctx,
    error_message: null,
  };

  return [newContext, effect];
}

export { send_authorization_request };
```