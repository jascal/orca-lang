// Effect routing and execution for Orca runtime
// Phase 1 only defines the types - full runtime comes in Phase 2

export interface Effect<T = unknown> {
  type: string;
  payload: T;
}

export interface EffectHandler<T = unknown> {
  (effect: Effect<T>): Promise<void> | void;
}

export interface EffectRouter {
  register<T>(type: string, handler: EffectHandler<T>): void;
  route<T>(effect: Effect<T>): Promise<void> | void;
}

export function createEffectRouter(): EffectRouter {
  const handlers = new Map<string, EffectHandler>();

  return {
    register(type, handler) {
      handlers.set(type, handler as EffectHandler);
    },
    route(effect) {
      const handler = handlers.get(effect.type);
      if (!handler) {
        throw new Error(`No handler registered for effect type: ${effect.type}`);
      }
      return handler(effect);
    },
  };
}

export function emit<T>(payload: T): Effect<T> {
  // This is a marker function - actual emission happens through the router
  return { type: 'unknown', payload };
}
