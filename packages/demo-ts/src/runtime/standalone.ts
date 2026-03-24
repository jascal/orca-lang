/**
 * Orca Runtime TS integration for retro-adventure-orca.
 *
 * This module provides access to the standalone TypeScript runtime
 * (orca-runtime-ts) as an alternative to the XState-based runtime.
 *
 * Usage:
 *   import { OrcaMachine, parseOrca } from './runtime/standalone';
 *   import { tokenize, parse } from 'orca'; // still use smgl for parsing if needed
 */

export {
  OrcaMachine,
  parseOrca,
  EventBus,
  getEventBus,
  resetEventBus,
  EventType,
  createEffectRouter,
} from '@orca-lang/orca-runtime-ts';

export type {
  Event,
  EventHandler,
  TransitionResult,
  TransitionCallback,
} from '@orca-lang/orca-runtime-ts';
