# machine Cell

## context
| Field     | Type | Default |
|-----------|------|---------|
| neighbors | int  | 0       |

## events
- count
- evolve
- spawn

## state dead [initial]

## state alive

## transitions
| Source | Event  | Guard          | Target | Action      |
|--------|--------|----------------|--------|-------------|
| dead   | count  |                | dead   | store_count |
| alive  | count  |                | alive  | store_count |
| alive  | evolve | neighbors == 2 | alive  |             |
| alive  | evolve | neighbors == 3 | alive  |             |
| alive  | evolve | else           | dead   |             |
| dead   | evolve | neighbors == 3 | alive  |             |
| dead   | evolve | else           | dead   |             |
| dead   | spawn  |                | alive  |             |

## actions
| Name        | Signature          |
|-------------|-------------------|
| store_count | `(ctx) -> Context` |
