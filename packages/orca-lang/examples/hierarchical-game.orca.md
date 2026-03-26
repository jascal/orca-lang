# machine HierarchicalGame

## context

| Field         | Type     | Default |
|---------------|----------|---------|
| current_room  | string   |         |
| inventory     | string[] |         |
| health        | int      | 100     |
| enemy_health  | int      | 50      |
| selected_item | string   |         |

## events

- start_game
- go_north
- go_south
- look
- attack
- defend
- use_item
- flee
- open_inventory
- close_inventory
- select_item
- game_over_trigger

## state idle [initial]
> Player is idle at the main menu
- on_entry: display_menu

## state exploration
> Player is exploring the world

### state overworld [initial]
> Player is in the overworld

### state dungeon
> Player is in a dungeon


## state combat
> Player is in combat

### state attacking [initial]
> Player is attacking

### state defending
> Player is defending

### state using_item
> Player is using an item


## state inventory
> Player has inventory open

### state closed [initial]
> Inventory is closed

### state open
> Inventory is open and visible

### state selecting
> Player is selecting an item


## state game_over [final]
> Game has ended

## transitions

| Source      | Event             | Guard             | Target      | Action             |
|-------------|-------------------|-------------------|-------------|--------------------|
| idle        | start_game        |                   | exploration |                    |
| exploration | go_north          |                   | exploration | move_north         |
| exploration | go_south          |                   | exploration | move_south         |
| exploration | look              |                   | exploration | describe_location  |
| exploration | attack            | enemy_present     | combat      |                    |
| exploration | open_inventory    |                   | inventory   |                    |
| combat      | attack            |                   | combat      | resolve_attack     |
| combat      | defend            |                   | combat      | start_defend       |
| combat      | use_item          | item_in_inventory | combat      | use_item_action    |
| combat      | flee              | can_flee          | exploration | flee_combat        |
| inventory   | close_inventory   |                   | exploration | close_inv          |
| inventory   | select_item       |                   | inventory   | select_item_action |
| exploration | game_over_trigger |                   | game_over   |                    |
| combat      | game_over_trigger |                   | game_over   |                    |

## guards

| Name              | Expression |
|-------------------|------------|
| enemy_present     | `true`     |
| can_flee          | `true`     |
| item_in_inventory | `true`     |

## actions

| Name               | Signature          |
|--------------------|--------------------|
| display_menu       | `(ctx) -> Context` |
| move_north         | `(ctx) -> Context` |
| move_south         | `(ctx) -> Context` |
| describe_location  | `(ctx) -> Context` |
| resolve_attack     | `(ctx) -> Context` |
| start_defend       | `(ctx) -> Context` |
| use_item_action    | `(ctx) -> Context` |
| flee_combat        | `(ctx) -> Context` |
| close_inv          | `(ctx) -> Context` |
| select_item_action | `(ctx) -> Context` |
