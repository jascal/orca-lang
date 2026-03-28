// Minimal Orca runtime for retro-adventure-orca
// This is a simplified version of the runtime from orca-lang

import { createActor, fromCallback } from 'xstate';
import type { Actor, AnyActor, AnyStateMachine } from 'xstate';
import type { Effect, EffectResult } from '@orcalang/orca-runtime-ts';

export interface EffectHandlers {
  [effectType: string]: (effect: Effect<unknown>) => Promise<EffectResult<unknown>>;
}

export interface OrcaMachineOptions {
  effectHandlers: EffectHandlers;
  onTransition?: (state: { value: string; context: Record<string, unknown> }) => void;
}

export interface OrcaState {
  value: string;
  context: Record<string, unknown>;
  status: 'active' | 'done' | 'error';
}

export interface OrcaMachine {
  start(): void;
  stop(): void;
  send(event: unknown): void;
  getState(): OrcaState;
}

export function createOrcaMachine(
  machineConfig: AnyStateMachine,
  options: OrcaMachineOptions
): OrcaMachine {
  // Build services from effect handlers
  const services: Record<string, any> = {};

  for (const [effectType, handler] of Object.entries(options.effectHandlers)) {
    services[`effect:${effectType}`] = fromCallback(({ sendBack, input }: any) => {
      const effect: Effect = { type: effectType, payload: input };

      Promise.resolve(handler(effect))
        .then((result) => {
          if (result.status === 'success') {
            sendBack({ type: 'EFFECT_SUCCESS', output: result.data });
          } else {
            sendBack({ type: 'EFFECT_FAILURE', error: result.error });
          }
        })
        .catch((error) => {
          sendBack({ type: 'EFFECT_FAILURE', error: error.message });
        });
    });
  }

  // Create machine with services
  const machine = machineConfig;

  // Create actor
  const actor = createActor(machine, { services });

  // Set up transition observer
  if (options.onTransition) {
    actor.subscribe((state) => {
      options.onTransition?.({
        value: state.value as string,
        context: state.context as Record<string, unknown>,
      });
    });
  }

  return {
    start: () => actor.start(),
    stop: () => actor.stop(),
    send: (event) => actor.send(event),
    getState: () => {
      const state = actor.getSnapshot();
      return {
        value: state.value as string,
        context: state.context as Record<string, unknown>,
        status: state.status as 'active' | 'done' | 'error',
      };
    },
  };
}
