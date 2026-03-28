// Effect handlers for retro-adventure Orca runtime

import type { Effect, EffectResult } from '@orcalang/orca-runtime-ts';

// Narrative request effect - calls LLM for game narration
export interface NarrativeRequest {
  prompt: string;
  context: {
    location: string;
    inventory: string[];
    recentHistory: string[];
    objectives: string[];
    action: string;
  };
}

export interface NarrativeResponse {
  narrative: string;
  newLocation?: string;
  itemsFound?: string[];
  events?: string[];
}

// Move request effect - handles location transitions
export interface MoveRequest {
  direction: string;
  currentLocation: string;
}

export interface MoveResponse {
  newLocation: string;
  description: string;
  visited: boolean;
}

// Save request effect - persists game state
export interface SaveRequest {
  sessionId: string;
  context: Record<string, unknown>;
}

export interface SaveResponse {
  saved: boolean;
  timestamp: number;
}

// Load request effect - restores game state
export interface LoadRequest {
  sessionId: string;
}

export interface LoadResponse {
  loaded: boolean;
  context?: Record<string, unknown>;
}

// Effect handler signatures
export type NarrativeEffectHandler = (effect: Effect<NarrativeRequest>) => Promise<EffectResult<NarrativeResponse>>;
export type MoveEffectHandler = (effect: Effect<MoveRequest>) => Promise<EffectResult<MoveResponse>>;
export type SaveEffectHandler = (effect: Effect<SaveRequest>) => Promise<EffectResult<SaveResponse>>;
export type LoadEffectHandler = (effect: Effect<LoadRequest>) => Promise<EffectResult<LoadResponse>>;

export interface GameEffectHandlers {
  NarrativeRequest: NarrativeEffectHandler;
  MoveRequest: MoveEffectHandler;
  SaveRequest: SaveEffectHandler;
  LoadRequest: LoadEffectHandler;
}
