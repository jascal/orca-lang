# machine SimpleToggle

## context

| Field | Type | Default |
|-------|------|---------|
| count | int  | 0       |

## events

- toggle
- reset

## state off [initial]
> Toggle is off

## state on
> Toggle is on

## transitions

| Source | Event  | Guard | Target | Action          |
|--------|--------|-------|--------|-----------------|
| off    | toggle |       | on     | increment_count |
| on     | toggle |       | off    | increment_count |
| off    | reset  |       | off    | reset_count     |
| on     | reset  |       | off    | reset_count     |

## guards

| Name       | Expression |
|------------|------------|
| can_toggle | `true`     |

## actions

| Name            | Signature          |
|-----------------|--------------------|
| increment_count | `(ctx) -> Context` |
| reset_count     | `(ctx) -> Context` |
