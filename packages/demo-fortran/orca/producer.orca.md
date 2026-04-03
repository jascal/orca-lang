# machine Producer

## context
| Field     | Type   | Default |
|-----------|--------|---------|
| agent_id  | string |         |
| inventory | int    | 100     |
| price     | float  | 10.0    |

## events
- tick
- price_signal

## state active [initial]
> Produces goods each tick, adjusts price based on market signal

## transitions
| Source  | Event        | Guard        | Target  | Action       |
|---------|--------------|--------------|---------|--------------|
| active  | tick         |              | active  | produce      |
| active  | price_signal | price > 15.0 | active  | cut_price    |
| active  | price_signal | price < 5.0  | active  | raise_price  |
| active  | price_signal | else         | active  | update_price |

## actions
| Name         | Signature           |
|--------------|---------------------|
| produce      | `(ctx) -> Context` |
| cut_price    | `(ctx) -> Context` |
| raise_price  | `(ctx) -> Context` |
| update_price | `(ctx) -> Context` |
