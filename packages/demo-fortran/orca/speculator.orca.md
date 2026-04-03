# machine Speculator

## context
| Field    | Type   | Default |
|----------|--------|---------|
| agent_id | string |         |
| cash     | float  | 500.0   |
| position | int    | 0       |
| price    | float  | 10.0    |

## events
- tick
- price_signal

## state idle [initial]
> Watching, waiting for a signal

## state holding [final]
> Committed to a position

## transitions
| Source  | Event        | Guard | Target  | Action       |
|---------|--------------|-------|---------|--------------|
| idle    | tick         |       | idle    | maybe_buy    |
| idle    | price_signal |       | idle    | update_price |
| holding | price_signal |       | holding | update_price |

## actions
| Name         | Signature          |
|--------------|--------------------|
| maybe_buy    | `(ctx) -> Context` |
| update_price | `(ctx) -> Context` |
