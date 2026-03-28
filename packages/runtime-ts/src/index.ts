/**
 * Orca Runtime TypeScript
 *
 * A first-class TypeScript async runtime for Orca state machines.
 */

// Types
export type {
  Context,
  StateDef,
  Transition,
  GuardDef,
  ActionSignature,
  MachineDef,
  GuardExpression,
  Effect,
  EffectResult,
  EffectStatus,
  EffectDef,
} from "./types.js";

export { StateValue } from "./types.js";

// Event Bus
export { EventBus, getEventBus, resetEventBus, EventType } from "./bus.js";
export type { Event, EventHandler } from "./bus.js";

// Effects
export type { EffectHandler, EffectRouter } from "./effects.js";
export { createEffectRouter } from "./effects.js";

// Machine
export { OrcaMachine } from "./machine.js";
export type { TransitionCallback, TransitionResult, ActionHandler } from "./machine.js";

// Parser
export { parseOrcaMd, parseOrcaAuto, ParseError } from "./parser.js";

// Persistence
export type { PersistenceAdapter } from "./persistence.js";
export { FilePersistence } from "./persistence.js";

// Logging
export type { LogSink, LogEntry } from "./logging.js";
export { FileSink, ConsoleSink, MultiSink, makeEntry } from "./logging.js";
