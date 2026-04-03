# machine Consumer

## context
| Field   | Type   | Default  |
|---------|--------|----------|
| agent_id| string |          |
| cash    | float  | 1000.0   |
| goods   | int    | 0        |
| price   | float  | 10.0     |

## events
- tick
- price_signal

## state active [initial]
> Each tick: buy if price is low, sell if high, hold otherwise

## transitions
| Source  | Event | Guard        | Target  | Action |
|---------|-------|--------------|---------|--------|
| active  | tick  | price < 8.0  | active  | buy    |
| active  | tick  | price > 12.0 | active  | sell   |
| active  | tick  | else         | active  | hold   |
| active  | price_signal |       | active  | update_price |

## actions
| Name         | Signature          |
|--------------|--------------------|
| buy          | `(ctx) -> Context` |
| sell         | `(ctx) -> Context` |
| hold         | `(ctx) -> Context` |
| update_price | `(ctx) -> Context` |
