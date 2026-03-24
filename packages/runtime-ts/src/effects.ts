/**
 * Effect types for Orca runtime.
 */

import type { Effect, EffectResult } from "./types.js";

export type { Effect, EffectResult } from "./types.js";

export type EffectHandler = (effect: Effect) => Promise<EffectResult>;

export interface EffectRouter {
  route(effect: Effect): Promise<EffectResult>;
  registerHandler(effectType: string, handler: EffectHandler): void;
  unregisterHandler(effectType: string): void;
}

export function createEffectRouter(): EffectRouter {
  const handlers = new Map<string, EffectHandler>();

  return {
    async route(effect: Effect): Promise<EffectResult> {
      const handler = handlers.get(effect.type);
      if (!handler) {
        return {
          status: "failure",
          error: `No handler registered for effect type: ${effect.type}`,
        };
      }

      try {
        return await handler(effect);
      } catch (error) {
        return {
          status: "failure",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },

    registerHandler(effectType: string, handler: EffectHandler): void {
      handlers.set(effectType, handler);
    },

    unregisterHandler(effectType: string): void {
      handlers.delete(effectType);
    },
  };
}
