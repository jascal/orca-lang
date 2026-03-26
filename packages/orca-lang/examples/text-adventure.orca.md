# machine TextAdventure

## context

| Field             | Type              | Default |
|-------------------|-------------------|---------|
| current_room      | string            |         |
| inventory         | string[]          |         |
| flags             | map<string, bool> |         |
| health            | int               | 100     |
| narrative_history | string[]          |         |

## events

- go_north
- go_south
- go_east
- go_west
- look
- take
- use
- talk
- attack
- flee
- game_over_trigger

## state exploring [initial]
> Player is exploring the world
- on_entry: describe_room

## state in_conversation
> Player is talking to an NPC
- on_entry: start_dialogue

## state in_combat
> Player is in combat with an enemy
- on_entry: describe_combat_start

## state game_over [final]
> Game has ended
- on_entry: describe_ending

## transitions

| Source          | Event             | Guard              | Target          | Action                   |
|-----------------|-------------------|--------------------|-----------------|--------------------------|
| exploring       | go_north          | north_exit_exists  | exploring       | move_north               |
| exploring       | go_south          | south_exit_exists  | exploring       | move_south               |
| exploring       | go_east           | east_exit_exists   | exploring       | move_east                |
| exploring       | go_west           | west_exit_exists   | exploring       | move_west                |
| exploring       | go_north          | !north_exit_exists | exploring       | describe_no_exit         |
| exploring       | go_south          | !south_exit_exists | exploring       | describe_no_exit         |
| exploring       | go_east           | !east_exit_exists  | exploring       | describe_no_exit         |
| exploring       | go_west           | !west_exit_exists  | exploring       | describe_no_exit         |
| exploring       | look              |                    | exploring       | describe_room_detail     |
| exploring       | take              | item_present       | exploring       | pick_up_item             |
| exploring       | take              | !item_present      | exploring       | describe_nothing_to_take |
| exploring       | talk              | npc_present        | in_conversation |                          |
| exploring       | talk              | !npc_present       | exploring       | describe_nobody_here     |
| exploring       | attack            | enemy_present      | in_combat       |                          |
| exploring       | game_over_trigger |                    | game_over       |                          |
| in_conversation | talk              |                    | in_conversation | continue_dialogue        |
| in_conversation | go_north          |                    | exploring       | exit_conversation        |
| in_conversation | go_south          |                    | exploring       | exit_conversation        |
| in_conversation | go_east           |                    | exploring       | exit_conversation        |
| in_conversation | go_west           |                    | exploring       | exit_conversation        |
| in_combat       | attack            |                    | in_combat       | resolve_attack           |
| in_combat       | flee              | can_flee           | exploring       | flee_combat              |
| in_combat       | flee              | !can_flee          | in_combat       | describe_cant_flee       |
| in_combat       | game_over_trigger |                    | game_over       |                          |

## guards

| Name              | Expression |
|-------------------|------------|
| north_exit_exists | `true`     |
| south_exit_exists | `true`     |
| east_exit_exists  | `true`     |
| west_exit_exists  | `true`     |
| item_present      | `true`     |
| npc_present       | `true`     |
| enemy_present     | `true`     |
| can_flee          | `true`     |

## actions

| Name                     | Signature          |
|--------------------------|--------------------|
| describe_room            | `(ctx) -> Context` |
| describe_room_detail     | `(ctx) -> Context` |
| move_north               | `(ctx) -> Context` |
| move_south               | `(ctx) -> Context` |
| move_east                | `(ctx) -> Context` |
| move_west                | `(ctx) -> Context` |
| describe_no_exit         | `(ctx) -> Context` |
| pick_up_item             | `(ctx) -> Context` |
| describe_nothing_to_take | `(ctx) -> Context` |
| start_dialogue           | `(ctx) -> Context` |
| continue_dialogue        | `(ctx) -> Context` |
| exit_conversation        | `(ctx) -> Context` |
| describe_nobody_here     | `(ctx) -> Context` |
| describe_combat_start    | `(ctx) -> Context` |
| resolve_attack           | `(ctx) -> Context` |
| flee_combat              | `(ctx) -> Context` |
| describe_cant_flee       | `(ctx) -> Context` |
| describe_ending          | `(ctx) -> Context` |
