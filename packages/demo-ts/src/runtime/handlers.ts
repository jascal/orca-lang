// Concrete effect handler implementations

import type { Effect, EffectResult } from '@orca-lang/orca-runtime-ts';
import { WORLD, describeLocation, getLocation } from './world';
import type {
  NarrativeRequest,
  NarrativeResponse,
  MoveRequest,
  MoveResponse,
  SaveRequest,
  SaveResponse,
  LoadRequest,
  LoadResponse,
  GameEffectHandlers,
} from './effects';

interface GameContext {
  session_id: string;
  current_location: string;
  inventory: string[];
  visited_locations: string[];
  health: number;
  score: number;
  narrative_history: string[];
  quest_objectives: string[];
  solved_puzzles: string[];
  triggered_beats: string[];
}

// In-memory game state (would be persisted in production)
let currentContext: GameContext = {
  session_id: 'demo-session',
  current_location: 'start',
  inventory: [],
  visited_locations: ['start'],
  health: 100,
  score: 0,
  narrative_history: [],
  quest_objectives: ['Explore the world', 'Find treasure'],
  solved_puzzles: [],
  triggered_beats: [],
};

export function getGameContext(): GameContext {
  return currentContext;
}

export function setGameContext(ctx: Partial<GameContext>): void {
  currentContext = { ...currentContext, ...ctx };
}

export function resetGameContext(): void {
  currentContext = {
    session_id: `session-${Date.now()}`,
    current_location: 'start',
    inventory: [],
    visited_locations: ['start'],
    health: 100,
    score: 0,
    narrative_history: [],
    quest_objectives: ['Explore the world', 'Find treasure'],
    solved_puzzles: [],
    triggered_beats: [],
  };
}

// Mock handlers for development/testing
export function createMockHandlers(): GameEffectHandlers {
  return {
    NarrativeRequest: async (effect: Effect<NarrativeRequest>): Promise<EffectResult<NarrativeResponse>> => {
      // Simulate LLM delay
      await new Promise(resolve => setTimeout(resolve, 100));

      const ctx = currentContext;
      const action = effect.payload?.action || 'look';

      let narrative = '';

      switch (action) {
        case 'call_llm_narrator': {
          // Determine what to narrate based on the event type
          const eventType = effect.payload?.event?.type;
          if (eventType === 'move') {
            const direction = effect.payload?.event?.direction || 'unknown';
            const loc = getLocation(ctx.current_location);
            if (loc && loc.exits[direction]) {
              const destination = loc.exits[direction];
              ctx.current_location = destination;
              if (!ctx.visited_locations.includes(destination)) {
                ctx.visited_locations.push(destination);
                ctx.score += 5;
              }
              narrative = describeLocation(destination);
              setGameContext(ctx);
            } else {
              narrative = `You can't go ${direction} from here.`;
            }
          } else if (eventType === 'take') {
            const item = effect.payload?.event?.item || 'something';
            const loc = getLocation(ctx.current_location);
            if (loc && loc.items.includes(item)) {
              narrative = `You pick up the ${item}. It might prove useful.`;
              ctx.inventory.push(item);
              ctx.score += 10;
              // Remove item from location
              loc.items = loc.items.filter(i => i !== item);
              setGameContext(ctx);
            } else {
              narrative = `There's no ${item} here to take.`;
            }
          } else if (eventType === 'drop') {
            const item = effect.payload?.event?.item || 'something';
            const idx = ctx.inventory.indexOf(item);
            if (idx >= 0) {
              ctx.inventory.splice(idx, 1);
              narrative = `You drop the ${item}.`;
              // Add item back to current location
              const loc = getLocation(ctx.current_location);
              if (loc) {
                loc.items.push(item);
              }
              setGameContext(ctx);
            } else {
              narrative = `You don't have a ${item} to drop.`;
            }
          } else if (eventType === 'inventory') {
            if (ctx.inventory.length === 0) {
              narrative = 'Your inventory is empty.';
            } else {
              narrative = 'You are carrying: ' + ctx.inventory.join(', ');
            }
          } else {
            // look, talk, examine, etc. - just describe current location
            narrative = describeLocation(ctx.current_location);
          }
          break;
        }
        case 'look':
        case 'call_llm_narrator':
          narrative = describeLocation(ctx.current_location);
          break;
        case 'take': {
          const item = effect.payload?.event?.item || 'something';
          const loc = getLocation(ctx.current_location);
          if (loc && loc.items.includes(item)) {
            narrative = `You pick up the ${item}. It might prove useful.`;
            ctx.inventory.push(item);
            ctx.score += 10;
            // Remove item from location
            loc.items = loc.items.filter(i => i !== item);
            setGameContext(ctx);
          } else {
            narrative = `There's no ${item} here to take.`;
          }
          break;
        }
        case 'drop': {
          const item = effect.payload?.event?.item || 'something';
          const idx = ctx.inventory.indexOf(item);
          if (idx >= 0) {
            ctx.inventory.splice(idx, 1);
            narrative = `You drop the ${item}.`;
            // Add item back to current location
            const loc = getLocation(ctx.current_location);
            if (loc) {
              loc.items.push(item);
            }
            setGameContext(ctx);
          } else {
            narrative = `You don't have a ${item} to drop.`;
          }
          break;
        }
        case 'talk':
          narrative = `An ancient voice echoes in your mind: "Seek the treasure in the dark cave...\"`;
          break;
        case 'examine': {
          const item = effect.payload?.event?.item || effect.payload?.event?.target;
          if (item) {
            narrative = `You examine the ${item} closely. Details emerge from the shadows.`;
          } else {
            narrative = describeLocation(ctx.current_location);
          }
          break;
        }
        case 'use': {
          const item = effect.payload?.event?.item || 'something';
          narrative = `You use the ${item}. Energy crackles through the air.`;
          break;
        }
        default:
          narrative = `The world shifts around you...`;
      }

      // Update context
      setGameContext(ctx);

      return {
        status: 'success',
        data: {
          narrative,
          newLocation: ctx.current_location,
        },
      };
    },

    MoveRequest: async (effect: Effect<MoveRequest>): Promise<EffectResult<MoveResponse>> => {
      await new Promise(resolve => setTimeout(resolve, 50));

      const ctx = currentContext;
      const direction = effect.payload?.direction || effect.payload?.event?.direction || 'unknown';

      const loc = getLocation(ctx.current_location);
      if (!loc) {
        return {
          status: 'failure',
          error: 'Current location not found in world',
        };
      }

      const destination = loc.exits[direction];
      if (!destination) {
        return {
          status: 'success',
          data: {
            newLocation: ctx.current_location,
            description: `You can't go ${direction} from here.`,
            visited: false,
          },
        };
      }

      const destLoc = getLocation(destination);
      ctx.current_location = destination;
      if (!ctx.visited_locations.includes(destination)) {
        ctx.visited_locations.push(destination);
        ctx.score += 5;
      }
      setGameContext(ctx);

      return {
        status: 'success',
        data: {
          newLocation: destination,
          description: describeLocation(destination),
          visited: ctx.visited_locations.includes(destination),
        },
      };
    },

    SaveRequest: async (effect: Effect<SaveRequest>): Promise<EffectResult<SaveResponse>> => {
      await new Promise(resolve => setTimeout(resolve, 50));

      // In a real implementation, this would write to a file
      const sessionId = effect.payload?.sessionId || currentContext.session_id;

      return {
        status: 'success',
        data: {
          saved: true,
          timestamp: Date.now(),
        },
      };
    },

    LoadRequest: async (effect: Effect<LoadRequest>): Promise<EffectResult<LoadResponse>> => {
      await new Promise(resolve => setTimeout(resolve, 50));

      // In a real implementation, this would read from a file
      return {
        status: 'success',
        data: {
          loaded: true,
          context: currentContext,
        },
      };
    },
  };
}

// Production handlers with real LLM integration
export function createProductionHandlers(apiKey: string): GameEffectHandlers {
  const mockHandlers = createMockHandlers();

  return {
    NarrativeRequest: async (effect: Effect<NarrativeRequest>): Promise<EffectResult<NarrativeResponse>> => {
      const ctx = currentContext;
      const action = effect.payload?.action || 'look';

      try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5',
            max_tokens: 1024,
            messages: [
              {
                role: 'user',
                content: `You are a text adventure game narrator. Generate a vivid, evocative description in 1-2 sentences.

Location: ${ctx.current_location}
Inventory: ${ctx.inventory.join(', ') || 'empty'}
Action: ${action}

Generate a narrative description:`,
              },
            ],
          }),
        });

        if (!response.ok) {
          throw new Error(`LLM API error: ${response.status}`);
        }

        const data = await response.json() as { content: Array<{ text: string }> };
        const narrative = data.content[0]?.text || 'The world seems to blur around you...';

        return {
          status: 'success',
          data: { narrative },
        };
      } catch (error) {
        return {
          status: 'failure',
          error: error instanceof Error ? error.message : 'Unknown LLM error',
        };
      }
    },

    MoveRequest: mockHandlers.MoveRequest,
    SaveRequest: mockHandlers.SaveRequest,
    LoadRequest: mockHandlers.LoadRequest,
  };
}
