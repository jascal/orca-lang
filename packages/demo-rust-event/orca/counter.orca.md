# machine Counter

## context
| Field   | Type | Default |
|---------|------|---------|
| count   | int  | 0       |
| max_val | int  | 100     |

## events
- increment
- decrement
- reset
- set_value

## state zero [initial]
> Count is zero

## state positive
> Count is positive (> 0)

## state negative
> Count is negative (< 0)

## state saturated
> Count has hit max_val or min boundary

## transitions
| Source    | Event     | Guard           | Target    | Action    |
|-----------|-----------|-----------------|-----------|-----------|
| zero      | increment | count < max_val | positive  | add_one   |
| zero      | decrement |                 | negative  | sub_one   |
| zero      | reset     |                 | zero      | clear     |
| positive  | increment | count < max_val | positive  | add_one   |
| positive  | increment | count >= max_val | saturated | saturate  |
| positive  | decrement |                 | zero      | sub_one   |
| positive  | reset     |                 | zero      | clear     |
| negative  | increment |                 | zero      | add_one   |
| negative  | decrement |                 | negative  | sub_one   |
| negative  | reset     |                 | zero      | clear     |
| saturated | decrement |                 | positive  | sub_one   |
| saturated | increment |                 | saturated |           |
| saturated | reset     |                 | zero      | clear     |

## actions
| Name      | Signature           | Effect     |
|-----------|---------------------|------------|
| add_one   | `(ctx) -> Context` | +1 to count |
| sub_one   | `(ctx) -> Context` | -1 to count |
| clear     | `(ctx) -> Context` | count = 0   |
| saturate  | `(ctx) -> Context` | count = max_val |

## effects
| Name       | Description                    |
|------------|--------------------------------|
| on_change  | Fired when count changes       |
| on_saturate | Fired when max is reached    |
