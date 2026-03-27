# machine OrderProcessor

## context

| Field | Type |
|-------|------|
| order_id | string |
| is_valid | boolean |

## events

- VALIDATED
- INVALID
- PROCESSED

## state validating [initial]
> Validating order with sub-machine
- invoke: OrderValidator input: { id: ctx.order_id }
- on_done: VALIDATED
- on_error: INVALID

## state validated
> Order is valid
- timeout: 5s -> processing

## state processing
> Processing validated order

## state invalid [final]
> Validation failed

## transitions

| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| validating | VALIDATED | | validated | |
| validating | INVALID | | invalid | |
| validated | timeout | | processing | |
| processing | | | done | |

## state done [final]
> Order processed

---

# machine OrderValidator

## context

| Field | Type |
|-------|------|
| id | string |

## events

- VALID
- INVALID

## state checking [initial]
> Checking order validity

## state valid [final]
> Order is valid

## state invalid [final]
> Order is invalid

## transitions

| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| checking | | id != "" | valid | |
| checking | | id == "" | invalid | |
