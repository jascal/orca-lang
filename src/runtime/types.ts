// Runtime types for Orca machine execution

import type { Effect, EffectResult } from './effects.js';
export type { Effect, EffectResult, EffectHandler, EffectRouter } from './effects.js';
export { createEffectRouter } from './effects.js';

export interface EffectHandlers {
  [effectType: string]: (effect: Effect) => Promise<EffectResult>;
}

export interface EffectResponseMapping {
  [effectType: string]: {
    success?: string;
    failure?: string;
    timeout?: string;
  };
}

export interface OrcaMachineOptions {
  effectHandlers: EffectHandlers;
  effectResponses?: EffectResponseMapping;
  onTransition?: (state: OrcaState) => void;
  onEffect?: (effect: Effect) => void;
}

export interface OrcaState {
  value: string;
  context: Record<string, unknown>;
  status: 'active' | 'done' | 'error';
}

export interface OrcaSnapshot {
  state: OrcaState;
  timestamp: number;
}

export interface OrcaMachine {
  start(): void;
  stop(): void;
  send(event: unknown): Promise<void>;
  getState(): OrcaState;
  snapshot(): OrcaSnapshot;
  restore(snapshot: OrcaSnapshot): void;
}
