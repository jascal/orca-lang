```typescript
function validate_payment_details(ctx: {
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
  const errors: string[] = [];

  if (!ctx.order_id || ctx.order_id.trim() === '') {
    errors.push('Order ID is required');
  }

  if (ctx.amount === undefined || ctx.amount === null || ctx.amount <= 0) {
    errors.push('Amount must be a positive number');
  }

  if (!ctx.currency || ctx.currency.trim() === '') {
    errors.push('Currency is required');
  } else {
    const validCurrencies = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY'];
    if (!validCurrencies.includes(ctx.currency.toUpperCase())) {
      errors.push(`Invalid currency: ${ctx.currency}. Supported currencies: ${validCurrencies.join(', ')}`);
    }
  }

  if (!ctx.payment_token || ctx.payment_token.trim() === '') {
    errors.push('Payment token is required');
  }

  if (errors.length > 0) {
    return {
      ...ctx,
      error_message: errors.join('; '),
    };
  }

  return {
    ...ctx,
    currency: ctx.currency.toUpperCase(),
    error_message: '',
  };
}
```