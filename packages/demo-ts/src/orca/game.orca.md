# machine GameEngine

## context

| Field                | Type     | Default |
|----------------------|----------|---------|
| session_id           | string   |         |
| current_location     | string   |         |
| inventory            | string[] |         |
| visited_locations    | string[] |         |
| health               | int      | 100     |
| score                | int      | 0       |
| narrative_history    | string[] |         |
| quest_objectives     | string[] |         |
| solved_puzzles       | string[] |         |
| triggered_beats      | string[] |         |

## events

- start_game
- submit_command
- command_parsed
- move
- look
- take
- drop
- use
- talk
- examine
- inventory
- save
- load
- llm_response
- llm_error
- invalid_command

## state setup [initial]
> Initial game setup state
- on_entry: create_session

## state idle
> Waiting for player input
- on_entry: prompt_player

## state parsing
> Parsing player command
- on_entry: parse_command

## state executing
> Executing parsed command
- on_entry: execute_command

## state generating_narrative
> Generating narrative via LLM
- on_entry: call_llm_narrator

## state responding
> Sending response to player
- on_entry: format_response

## state error
> Handling error state

## state game_over [final]
> Game has ended

## transitions

| Source              | Event           | Guard            | Target                | Action           |
|---------------------|-----------------|------------------|----------------------|------------------|
| setup               | start_game      |                  | idle                 | create_session   |
| idle                | submit_command  |                  | parsing              |                  |
| idle                | look            |                  | generating_narrative |                  |
| idle                | move            |                  | generating_narrative |                  |
| idle                | take            |                  | generating_narrative |                  |
| idle                | drop            |                  | generating_narrative |                  |
| idle                | use             |                  | generating_narrative |                  |
| idle                | talk            |                  | generating_narrative |                  |
| idle                | examine         |                  | generating_narrative |                  |
| idle                | inventory       |                  | generating_narrative |                  |
| idle                | save            |                  | idle                 | save_game_state  |
| idle                | load            |                  | idle                 | load_game_state  |
| idle                | game_over       |                  | game_over            |                  |
| parsing             | command_parsed  |                  | executing            |                  |
| parsing             | invalid_command |                  | responding           | format_error     |
| executing           | move            |                  | generating_narrative |                  |
| executing           | look            |                  | generating_narrative |                  |
| executing           | take            |                  | generating_narrative |                  |
| executing           | drop            |                  | generating_narrative |                  |
| executing           | use             |                  | generating_narrative |                  |
| executing           | talk            |                  | generating_narrative |                  |
| executing           | examine         |                  | generating_narrative |                  |
| generating_narrative | llm_response   |                  | responding           | process_narrative |
| generating_narrative | llm_error      |                  | error                | handle_llm_error |
| responding          | submit_command  |                  | idle                 | clear_prompt     |
| responding          | look            |                  | idle                 |                  |
| responding          | inventory       |                  | idle                 |                  |
| error               | invalid_command |                  | idle                 | recover_from_error |

## guards

| Name            | Expression                    |
|-----------------|-------------------------------|
| is_valid_move   | `ctx.current_location != ""`   |
| has_inventory_items | `ctx.inventory.length > 0` |
| can_take_item   | `true`                        |
| can_examine     | `true`                        |
| llm_call_succeeded | `true`                    |

## effects

| Name              | Input                                                             | Output                                   |
|-------------------|-------------------------------------------------------------------|------------------------------------------|
| NarrativeRequest  | `{ location: string, command: string, inventory: string[] }`     | `{ narrative: string }`                  |
| SaveRequest       | `{ session_id: string, state: string, context: object }`         | `{ saved: bool, slot: string }`          |
| LoadRequest       | `{ session_id: string }`                                         | `{ context: object, found: bool }`       |

## actions

| Name               | Signature                      | Effect                        |
|--------------------|--------------------------------|-------------------------------|
| create_session     | `(ctx) -> Context`             |                               |
| prompt_player      | `(ctx) -> Context`             |                               |
| parse_command      | `(ctx) -> Context`             |                               |
| execute_command    | `(ctx) -> Context`            |                               |
| prepare_move       | `(ctx) -> Context`             | MoveRequest                   |
| prepare_look       | `(ctx) -> Context`             | NarrativeRequest              |
| prepare_use        | `(ctx) -> Context`             | NarrativeRequest              |
| prepare_talk       | `(ctx) -> Context`             | NarrativeRequest              |
| prepare_examine    | `(ctx) -> Context`             | NarrativeRequest              |
| execute_take       | `(ctx) -> Context`             |                               |
| execute_drop       | `(ctx) -> Context`             |                               |
| show_inventory     | `(ctx) -> Context`             |                               |
| save_game_state    | `(ctx) -> Context`             | SaveRequest                   |
| load_game_state    | `(ctx) -> Context`             | LoadRequest                   |
| call_llm_narrator  | `(ctx) -> Context`             | NarrativeRequest              |
| process_narrative  | `(ctx) -> Context`             |                               |
| handle_llm_error   | `(ctx) -> Context`             |                               |
| format_response    | `(ctx) -> Context`             |                               |
| format_error       | `(ctx) -> Context`             |                               |
| recover_from_error | `(ctx) -> Context`            |                               |
| clear_prompt       | `(ctx) -> Context`             |                               |
