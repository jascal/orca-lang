/**
 * Orca compatibility shim
 *
 * Wraps @orcalang/orca-runtime-ts to provide the same interface
 * as the full orca language package (tokenize, parse, createOrcaMachine).
 */

import { parseOrcaAuto, OrcaMachine, EventBus, getEventBus, resetEventBus, EventType, createEffectRouter } from '@orcalang/orca-runtime-ts';
import type { MachineDef } from '@orcalang/orca-runtime-ts';

// Re-export types and runtime components
export { OrcaMachine, EventBus, getEventBus, resetEventBus, EventType, createEffectRouter };
export type { MachineDef, Event, TransitionCallback, TransitionResult } from '@orcalang/orca-runtime-ts';

// Tokenize - returns source as-is (preserving structure for parser)
export function tokenize(source: string): string {
  return source;
}

// Parse - auto-detects format (DSL or markdown) and parses accordingly
export function parse(source: string): { machine: MachineDef } {
  const machine = parseOrcaAuto(source);
  return { machine };
}

// Compile to XState - not implemented in runtime, returns empty object
export function compileToXStateMachine(_machine: MachineDef): any {
  return {
    config: { states: {} },
    effectMeta: { effectfulActions: [] }
  };
}

// Create OrcaMachine - factory function compatible with orca package
export interface CreateOrcaMachineOptions {
  effectHandlers?: Record<string, any>;
  onTransition?: (state: any) => void;
  context?: Record<string, unknown>;
}

export function createOrcaMachine(
  machineDef: MachineDef,
  options: CreateOrcaMachineOptions = {}
): any {
  const bus = getEventBus();

  // Register effect handlers
  if (options.effectHandlers) {
    for (const [name, handler] of Object.entries(options.effectHandlers)) {
      bus.registerEffectHandler(name, handler);
    }
  }

  const machine = new OrcaMachine(
    machineDef,
    bus,
    options.context,
    options.onTransition ? async (from, to) => options.onTransition?.({ value: to.toString(), context: machine.context }) : undefined
  );

  return {
    machine,
    start: () => machine.start(),
    stop: () => machine.stop(),
    send: (event: any) => machine.send(event),
    getState: () => ({ value: machine.currentState.toString(), context: machine.context }),
    registerAction: (name: string, handler: any) => machine.registerAction(name, handler),
  };
}
