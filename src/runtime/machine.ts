// Orca Machine Runtime - creates executable state machines

import { createActor, createMachine, fromCallback } from 'xstate';
import type { Actor } from 'xstate';
import { compileToXStateMachine, CompiledMachine } from '../compiler/xstate.js';
import { MachineDef } from '../parser/ast.js';
import {
  EffectHandlers,
  EffectResponseMapping,
  OrcaMachineOptions,
  OrcaState,
  OrcaSnapshot,
  OrcaMachine,
} from './types.js';
import type { Effect } from './effects.js';

/**
 * Create an executable Orca machine with effect handling
 */
export function createOrcaMachine(
  machineOrDef: MachineDef | CompiledMachine,
  options: OrcaMachineOptions
): OrcaMachine {
  let compiled: CompiledMachine;
  let machineDef: MachineDef;

  if ('effectMeta' in machineOrDef) {
    // Already compiled
    compiled = machineOrDef;
    machineDef = {} as MachineDef; // Not needed for runtime
  } else {
    machineDef = machineOrDef;
    compiled = compileToXStateMachine(machineDef);
  }

  // Build effect services from handlers
  const services = buildEffectServices(compiled.effectMeta.effectfulActions, options.effectHandlers);

  // Create the XState machine with services
  const machine = createMachine({
    ...compiled.config,
    services,
  });

  // Create and start the actor
  const actor = createActor(machine);

  // Set up transition observer
  if (options.onTransition) {
    actor.subscribe((state) => {
      options.onTransition?.({
        value: state.value as string,
        context: state.context as Record<string, unknown>,
        status: state.status as 'active' | 'done' | 'error',
      });
    });
  }

  return new OrcaMachineImpl(actor, options);
}

function buildEffectServices(
  effectfulActions: CompiledMachine['effectMeta']['effectfulActions'],
  handlers: EffectHandlers
): Record<string, any> {
  const services: Record<string, any> = {};

  for (const action of effectfulActions) {
    const handler = handlers[action.effectType];
    if (handler) {
      services[`effect:${action.effectType}`] = fromCallback(({ sendBack, input }: any) => {
        const effect: Effect = {
          type: action.effectType,
          payload: input,
        };

        Promise.resolve(handler(effect)).then((result) => {
          if (result.status === 'success') {
            sendBack({ type: 'EFFECT_SUCCESS', output: result.data });
          } else if (result.status === 'failure') {
            sendBack({ type: 'EFFECT_FAILURE', error: result.error });
          } else if (result.status === 'timeout') {
            sendBack({ type: 'EFFECT_TIMEOUT' });
          }
        }).catch((error) => {
          sendBack({ type: 'EFFECT_FAILURE', error: error.message });
        });
      });
    }
  }

  return services;
}

class OrcaMachineImpl implements OrcaMachine {
  private actor: Actor<any>;
  private options: OrcaMachineOptions;

  constructor(actor: Actor<any>, options: OrcaMachineOptions) {
    this.actor = actor;
    this.options = options;
  }

  start(): void {
    this.actor.start();
  }

  stop(): void {
    this.actor.stop();
  }

  async send(event: unknown): Promise<void> {
    this.actor.send(event as any);
  }

  getState(): OrcaState {
    const state = this.actor.getSnapshot();
    return {
      value: state.value as string,
      context: state.context as Record<string, unknown>,
      status: state.status as 'active' | 'done' | 'error',
    };
  }

  snapshot(): OrcaSnapshot {
    return {
      state: this.getState(),
      timestamp: Date.now(),
    };
  }

  restore(_snapshot: OrcaSnapshot): void {
    // XState actors don't directly support restore
    // The machine must be re-created with the snapshot's context
    throw new Error('restore() is not yet implemented. Use initial context to re-create machine state.');
  }
}
