```typescript
function format_decline_reason(ctx: Context, event: Event): Context {
  const rawReason = event.reason || event.decline_reason || event.error || ctx.error_message || "Unknown decline reason";
  
  const reasonMap: Record<string, string> = {
    "insufficient_funds": "Payment declined: Insufficient funds available.",
    "card_expired": "Payment declined: Card has expired.",
    "invalid_card": "Payment declined: Invalid card details.",
    "do_not_honor": "Payment declined: Card issuer declined the transaction.",
    "fraud_suspected": "Payment declined: Transaction flagged for security review.",
    "limit_exceeded": "Payment declined: Transaction limit exceeded.",
    "card_not_supported": "Payment declined: Card type not supported.",
    "processing_error": "Payment declined: A processing error occurred.",
    "invalid_amount": "Payment declined: Invalid transaction amount.",
    "stolen_card": "Payment declined: Card reported as stolen.",
    "lost_card": "Payment declined: Card reported as lost.",
  };

  const normalizedReason = String(rawReason).toLowerCase().trim().replace(/\s+/g, "_");
  
  const formattedMessage = reasonMap[normalizedReason] 
    || `Payment declined: ${String(rawReason).charAt(0).toUpperCase() + String(rawReason).slice(1)}.`;

  return {
    ...ctx,
    error_message: formattedMessage,
  };
}
```