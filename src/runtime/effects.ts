// Effect routing and execution for Orca runtime

export interface Effect<T = unknown> {
  type: string;
  payload: T;
}

export interface EffectResult {
  status: 'success' | 'failure' | 'timeout';
  data?: unknown;
  error?: string;
}

export type EffectHandler<T = unknown> = (effect: Effect<T>) => Promise<EffectResult> | EffectResult;

export interface EffectRouter {
  register<T>(type: string, handler: EffectHandler<T>): void;
  route<T>(effect: Effect<T>): Promise<EffectResult>;
}

export function createEffectRouter(handlers?: Record<string, EffectHandler>): EffectRouter {
  const handlerMap = new Map<string, EffectHandler<unknown>>();
  if (handlers) {
    for (const [key, value] of Object.entries(handlers)) {
      handlerMap.set(key, value as EffectHandler<unknown>);
    }
  }

  return {
    register(type, handler) {
      handlerMap.set(type, handler as EffectHandler<unknown>);
    },
    route(effect) {
      const handler = handlerMap.get(effect.type) as EffectHandler<unknown> | undefined;
      if (!handler) {
        return Promise.resolve({
          status: 'failure' as const,
          error: `No handler registered for effect type: ${effect.type}`,
        });
      }
      return Promise.resolve(handler(effect));
    },
  };
}

export function emit<T>(payload: T, type: string = 'anonymous'): Effect<T> {
  return { type, payload };
}
