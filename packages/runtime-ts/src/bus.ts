/**
 * Async event bus with pub/sub and request/response patterns.
 */

import type { Effect, EffectResult } from "./types.js";
import type { EffectHandler } from "./effects.js";

export const EventType = {
  STATE_CHANGED: "orca.state.changed",
  TRANSITION_STARTED: "orca.transition.started",
  TRANSITION_COMPLETED: "orca.transition.completed",
  EFFECT_EXECUTING: "orca.effect.executing",
  EFFECT_COMPLETED: "orca.effect.completed",
  EFFECT_FAILED: "orca.effect.failed",
  MACHINE_STARTED: "orca.machine.started",
  MACHINE_STOPPED: "orca.machine.stopped",
  WORKFLOW_STATE_CHANGED: "workflow.state.changed",
  AGENT_TASK_ASSIGNED: "agent.task.assigned",
  AGENT_TASK_COMPLETED: "agent.task.completed",
  SCHEDULING_QUERY: "scheduling.query",
  SCHEDULING_QUERY_RESPONSE: "scheduling.query_response",
} as const;

export type EventType = (typeof EventType)[keyof typeof EventType];

export interface Event {
  type: EventType;
  source: string;
  eventName?: string;
  correlationId?: string;
  timestamp: Date;
  payload: Record<string, unknown>;
}

export type EventHandler = (event: Event) => Promise<void>;

export class EventBus {
  private subscribers = new Map<EventType, Set<EventHandler>>();
  private effectHandlers = new Map<string, EffectHandler>();
  private responseQueues = new Map<string, AsyncQueue<Event>>();

  subscribe(eventType: EventType, handler: EventHandler): void {
    if (!this.subscribers.has(eventType)) {
      this.subscribers.set(eventType, new Set());
    }
    this.subscribers.get(eventType)!.add(handler);
  }

  unsubscribe(eventType: EventType, handler: EventHandler): void {
    const handlers = this.subscribers.get(eventType);
    if (handlers) {
      handlers.delete(handler);
    }
  }

  async publish(event: Event): Promise<void> {
    const handlers = this.subscribers.get(event.type);
    if (!handlers || handlers.size === 0) {
      return;
    }

    const promises: Promise<void>[] = [];
    for (const handler of handlers) {
      promises.push(handler(event).catch(() => {}));
    }
    await Promise.all(promises);
  }

  registerEffectHandler(effectType: string, handler: EffectHandler): void {
    this.effectHandlers.set(effectType, handler);
  }

  unregisterEffectHandler(effectType: string): void {
    this.effectHandlers.delete(effectType);
  }

  async executeEffect(effect: Effect): Promise<EffectResult> {
    const handler = this.effectHandlers.get(effect.type);
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
  }

  async requestResponse<T = unknown>(
    requestType: EventType,
    requestPayload: Record<string, unknown>,
    responseType: EventType,
    correlationId?: string,
    timeout = 5000,
    source = "orca"
  ): Promise<T> {
    const corrId = correlationId ?? crypto.randomUUID();
    const responseQueue = new AsyncQueue<Event>();
    this.responseQueues.set(corrId, responseQueue);

    const responseHandler = async (event: Event): Promise<void> => {
      if (event.correlationId === corrId) {
        responseQueue.push(event);
      }
    };

    this.subscribe(responseType, responseHandler);

    try {
      await this.publish({
        type: requestType,
        source,
        correlationId: corrId,
        timestamp: new Date(),
        payload: requestPayload,
      });

      const event = await responseQueue.pop(timeout);
      return event.payload as T;
    } catch (error) {
      throw new Error(
        `Request ${corrId} timed out after ${timeout}ms`
      );
    } finally {
      this.unsubscribe(responseType, responseHandler);
      this.responseQueues.delete(corrId);
    }
  }

  get effectHandlerTypes(): string[] {
    return Array.from(this.effectHandlers.keys());
  }
}

/**
 * Simple async queue for event bus request/response.
 */
class AsyncQueue<T> {
  private queue: T[] = [];
  private resolvers: Array<(value: T) => void> = [];

  push(value: T): void {
    if (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()!;
      resolve(value);
    } else {
      this.queue.push(value);
    }
  }

  async pop(timeout: number): Promise<T> {
    if (this.queue.length > 0) {
      return this.queue.shift()!;
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.resolvers.indexOf(resolve);
        if (index !== -1) {
          this.resolvers.splice(index, 1);
        }
        reject(new Error("Timeout"));
      }, timeout);

      this.resolvers.push((value: T) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }
}

// Global event bus instance
let globalBus: EventBus | null = null;

export function getEventBus(): EventBus {
  if (!globalBus) {
    globalBus = new EventBus();
  }
  return globalBus;
}

export function resetEventBus(): void {
  globalBus = null;
}
