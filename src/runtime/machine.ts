// Orca Machine Runtime - creates executable state machines

import { createActor, createMachine, fromPromise } from 'xstate';
import { assign } from 'xstate';
import type { Actor } from 'xstate';
import { compileToXStateMachine, CompiledMachine } from '../compiler/xstate.js';
import { MachineDef } from '../parser/ast.js';
import {
  EffectHandlers,
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
    compiled = machineOrDef;
    machineDef = {} as MachineDef;
  } else {
    machineDef = machineOrDef;
    compiled = compileToXStateMachine(machineDef);
  }

  // Preprocess the config to inline fromPromise for effect invocations
  const config = preprocessEffectInvokes(compiled.config, compiled.effectMeta.effectfulActions, options.effectHandlers);

  // Create the XState machine
  const machine = createMachine(config);

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

/**
 * Preprocess the machine config to replace __effect__:type references
 * with actual fromPromise inline invocations.
 */
function preprocessEffectInvokes(
  config: any,
  effectfulActions: CompiledMachine['effectMeta']['effectfulActions'],
  handlers: EffectHandlers
): any {
  // Build a map of effectType -> handler
  const handlerMap = new Map<string, any>();
  for (const action of effectfulActions) {
    const handler = handlers[action.effectType];
    if (handler && typeof handler === 'function') {
      handlerMap.set(action.effectType, { handler, action });
    }
  }

  // Deep clone the config preserving functions
  const processedConfig = deepCloneWithInvokeReplacement(config, handlerMap);

  return processedConfig;
}

/**
 * Deep clone config while replacing __effect__:type invoke src with fromPromise.
 * Preserves functions (unlike JSON serialization).
 */
function deepCloneWithInvokeReplacement(obj: any, handlerMap: Map<string, any>): any {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => deepCloneWithInvokeReplacement(item, handlerMap));
  }

  // Check if this is an invoke object with __effect__:type src
  if ('src' in obj && typeof obj.src === 'string' && obj.src.startsWith('__effect__:')) {
    const effectType = obj.src.replace('__effect__:', '');
    const entryHandler = handlerMap.get(effectType);

    if (entryHandler) {
      // Create new invoke object with fromPromise replacing the string src
      const newObj: any = { ...obj };
      newObj.src = fromPromise(async ({ input }: { input: any }) => {
        const effect: Effect = {
          type: effectType,
          payload: input,
        };
        try {
          const result = await Promise.resolve(entryHandler.handler(effect));
          return result;
        } catch (err) {
          throw err;
        }
      });
      // Clone other properties recursively
      for (const key of Object.keys(obj)) {
        if (key !== 'src') {
          newObj[key] = deepCloneWithInvokeReplacement(obj[key], handlerMap);
        }
      }
      return newObj;
    }
  }

  // Regular object - clone all properties
  const newObj: any = {};
  for (const key of Object.keys(obj)) {
    newObj[key] = deepCloneWithInvokeReplacement(obj[key], handlerMap);
  }
  return newObj;
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
    throw new Error('restore() is not yet implemented. Use initial context to re-create machine state.');
  }
}
