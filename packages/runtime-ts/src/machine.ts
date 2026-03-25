/**
 * Orca state machine runtime.
 *
 * Async state machine that executes Orca machine definitions,
 * publishing state changes to an event bus and executing effects
 * via registered handlers.
 */

import type {
  MachineDef,
  StateDef,
  Transition,
  ActionSignature,
  GuardExpression,
  VariableRef,
  ValueRef,
} from "./types.js";
import { StateValue, Effect, EffectResult, EffectStatus } from "./types.js";
import type { EventBus, Event, EventType } from "./bus.js";
import { getEventBus } from "./bus.js";

export type TransitionCallback = (
  fromState: StateValue,
  toState: StateValue
) => Promise<void>;

export type ActionHandler = (
  context: Record<string, unknown>,
  event?: Record<string, unknown>
) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;

export interface TransitionResult {
  taken: boolean;
  fromState: string;
  toState?: string;
  guardFailed?: boolean;
  error?: string;
}

export class OrcaMachine {
  private definition: MachineDef;
  private eventBus: EventBus;
  private context: Record<string, unknown>;
  private onTransition?: TransitionCallback;
  private state: StateValue;
  private active = false;
  private actionHandlers = new Map<string, ActionHandler>();
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    definition: MachineDef,
    eventBus?: EventBus,
    context?: Record<string, unknown>,
    onTransition?: TransitionCallback
  ) {
    this.definition = definition;
    this.eventBus = eventBus ?? getEventBus();
    this.context = context ?? { ...definition.context };
    this.onTransition = onTransition;
    this.state = new StateValue(this.getInitialState());
  }

  registerAction(name: string, handler: ActionHandler): void {
    this.actionHandlers.set(name, handler);
  }

  unregisterAction(name: string): void {
    this.actionHandlers.delete(name);
  }

  private getInitialState(): string {
    for (const state of this.definition.states) {
      if (state.isInitial) {
        return state.name;
      }
    }
    if (this.definition.states.length > 0) {
      return this.definition.states[0].name;
    }
    return "unknown";
  }

  get currentState(): StateValue {
    return this.state;
  }

  get isActive(): boolean {
    return this.active;
  }

  async start(): Promise<void> {
    if (this.active) {
      return;
    }

    this.active = true;

    await this.eventBus.publish({
      type: "orca.machine.started",
      source: this.definition.name,
      timestamp: new Date(),
      payload: {
        machine: this.definition.name,
        initial_state: this.state.toString(),
      },
    });

    // Execute entry actions for initial state
    await this.executeEntryActions(this.state.leaf());

    // Start timeout for initial state if defined
    this.startTimeoutForState(this.state.leaf());
  }

  async stop(): Promise<void> {
    if (!this.active) {
      return;
    }

    this.cancelTimeout();
    this.active = false;

    await this.eventBus.publish({
      type: "orca.machine.stopped",
      source: this.definition.name,
      timestamp: new Date(),
      payload: {},
    });
  }

  async send(event: string | Event, payload?: Record<string, unknown>): Promise<TransitionResult> {
    if (!this.active) {
      return {
        taken: false,
        fromState: this.state.toString(),
        error: "Machine is not active",
      };
    }

    // Normalize to Event
    let evt: Event;
    if (typeof event === "string") {
      evt = {
        type: this.findEventType(event),
        source: this.definition.name,
        eventName: event,
        timestamp: new Date(),
        payload: payload ?? {},
      };
    } else {
      evt = event;
    }

    // Check if event is explicitly ignored in current state
    const eventKey = evt.eventName ?? evt.type;
    if (this.isEventIgnored(eventKey)) {
      return {
        taken: false,
        fromState: this.state.toString(),
      };
    }

    // Find matching transition
    const transition = this.findTransition(evt);

    if (!transition) {
      return {
        taken: false,
        fromState: this.state.toString(),
        error: `No transition for event ${eventKey} from ${this.state.leaf()}`,
      };
    }

    // Evaluate guard if present
    if (transition.guard) {
      const guardPassed = await this.evaluateGuard(transition.guard);
      if (!guardPassed) {
        return {
          taken: false,
          fromState: this.state.toString(),
          guardFailed: true,
          error: `Guard '${transition.guard}' failed`,
        };
      }
    }

    // Execute the transition
    const oldState = new StateValue(this.state.value);
    const newStateName = transition.target;

    // Cancel any active timeout from the old state
    this.cancelTimeout();

    // Execute exit actions
    await this.executeExitActions(oldState.leaf());

    // Execute transition action
    if (transition.action) {
      await this.executeAction(transition.action, evt.payload);
    }

    // Update state
    if (this.isCompoundState(newStateName)) {
      const initialChild = this.getInitialChild(newStateName);
      this.state = new StateValue({ [newStateName]: { [initialChild]: {} } });
    } else {
      this.state = new StateValue(newStateName);
    }

    // Publish transition started
    await this.eventBus.publish({
      type: "orca.transition.started",
      source: this.definition.name,
      timestamp: new Date(),
      payload: {
        from: oldState.toString(),
        to: newStateName,
        trigger: evt.eventName ?? evt.type,
      },
    });

    // Execute entry actions for new state
    await this.executeEntryActions(newStateName);

    // Start timeout for new state if defined
    this.startTimeoutForState(this.state.leaf());

    // Notify callback
    if (this.onTransition) {
      await this.onTransition(oldState, this.state);
    }

    // Publish transition completed
    await this.eventBus.publish({
      type: "orca.transition.completed",
      source: this.definition.name,
      timestamp: new Date(),
      payload: {
        from: oldState.toString(),
        to: this.state.toString(),
      },
    });

    return {
      taken: true,
      fromState: oldState.toString(),
      toState: this.state.toString(),
    };
  }

  private findEventType(eventName: string): EventType {
    const eventTypeMap: Record<string, EventType> = {
      "state_changed": "orca.state.changed",
      "transition_started": "orca.transition.started",
      "transition_completed": "orca.transition.completed",
      "effect_executing": "orca.effect.executing",
      "effect_completed": "orca.effect.completed",
      "effect_failed": "orca.effect.failed",
      "machine_started": "orca.machine.started",
      "machine_stopped": "orca.machine.stopped",
    };

    const normalized = eventName.toLowerCase().replace(/-/g, "_");

    if (normalized in eventTypeMap) {
      return eventTypeMap[normalized];
    }

    for (const definedEvent of this.definition.events) {
      if (definedEvent.toLowerCase().replace(/-/g, "_") === normalized) {
        return "orca.state.changed";
      }
    }

    return "orca.state.changed";
  }

  private findTransition(event: Event): Transition | null {
    const current = this.state.leaf();
    const eventKey = event.eventName ?? event.type;

    // Try direct match on current state
    for (const t of this.definition.transitions) {
      if (t.source === current && t.event === eventKey) {
        return t;
      }
    }

    // For compound states, also check parent's transitions
    let parent = this.getParentState(current);
    while (parent) {
      for (const t of this.definition.transitions) {
        if (t.source === parent && t.event === eventKey) {
          return t;
        }
      }
      parent = this.getParentState(parent);
    }

    return null;
  }

  private getParentState(stateName: string): string | null {
    for (const state of this.definition.states) {
      if (state.name === stateName) {
        return state.parent ?? null;
      }
      if (state.contains) {
        for (const child of state.contains) {
          if (child.name === stateName) {
            return state.name;
          }
        }
      }
    }
    return null;
  }

  private isCompoundState(stateName: string): boolean {
    for (const state of this.definition.states) {
      if (state.name === stateName) {
        return state.contains !== undefined && state.contains.length > 0;
      }
      if (state.contains) {
        for (const child of state.contains) {
          if (child.name === stateName) {
            return false;
          }
        }
      }
    }
    return false;
  }

  private getInitialChild(parentName: string): string {
    for (const state of this.definition.states) {
      if (state.name === parentName && state.contains) {
        for (const child of state.contains) {
          if (child.isInitial) {
            return child.name;
          }
        }
        return state.contains[0].name;
      }
    }
    return parentName;
  }

  private async evaluateGuard(guardName: string): Promise<boolean> {
    if (!(guardName in this.definition.guards)) {
      return true; // Unknown guard = allow
    }

    const guardExpr = this.definition.guards[guardName];
    return this.evalGuard(guardExpr);
  }

  private async evalGuard(expr: GuardExpression): Promise<boolean> {
    switch (expr.kind) {
      case "true":
        return true;
      case "false":
        return false;
      case "not":
        return !(await this.evalGuard(expr.expr));
      case "and":
        return (await this.evalGuard(expr.left)) && (await this.evalGuard(expr.right));
      case "or":
        return (await this.evalGuard(expr.left)) || (await this.evalGuard(expr.right));
      case "compare":
        return this.evalCompare(expr.op, expr.left, expr.right);
      case "nullcheck":
        return this.evalNullcheck(expr.expr, expr.isNull);
      default:
        return true;
    }
  }

  private resolveVariable(ref: VariableRef): unknown {
    let current: unknown = this.context;
    for (const part of ref.path) {
      // Skip "ctx" or "context" prefix — the context is already the root
      if (part === "ctx" || part === "context") continue;
      if (current === null || current === undefined) return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }

  private resolveValue(ref: ValueRef): unknown {
    return ref.value;
  }

  private evalCompare(op: string, left: VariableRef, right: ValueRef): boolean {
    const lhs = this.resolveVariable(left);
    const rhs = this.resolveValue(right);

    // Coerce to number for numeric comparisons if both sides are numeric
    const lNum = typeof lhs === "number" ? lhs : Number(lhs);
    const rNum = typeof rhs === "number" ? rhs : Number(rhs);
    const bothNumeric = !isNaN(lNum) && !isNaN(rNum);

    switch (op) {
      case "eq":
        // eslint-disable-next-line eqeqeq
        return lhs == rhs;
      case "ne":
        // eslint-disable-next-line eqeqeq
        return lhs != rhs;
      case "lt":
        return bothNumeric ? lNum < rNum : String(lhs) < String(rhs);
      case "gt":
        return bothNumeric ? lNum > rNum : String(lhs) > String(rhs);
      case "le":
        return bothNumeric ? lNum <= rNum : String(lhs) <= String(rhs);
      case "ge":
        return bothNumeric ? lNum >= rNum : String(lhs) >= String(rhs);
      default:
        return false;
    }
  }

  private evalNullcheck(expr: VariableRef, isNull: boolean): boolean {
    const val = this.resolveVariable(expr);
    const valueIsNull = val === null || val === undefined;
    return isNull ? valueIsNull : !valueIsNull;
  }

  private async executeEntryActions(stateName: string): Promise<void> {
    const stateDef = this.findStateDef(stateName);
    if (!stateDef || !stateDef.onEntry) {
      return;
    }

    const actionDef = this.findActionDef(stateDef.onEntry);
    if (actionDef?.hasEffect) {
      const effect: Effect = {
        type: actionDef.effectType ?? "Effect",
        payload: {
          action: stateDef.onEntry,
          context: this.context,
          event: null,
        },
      };

      await this.eventBus.publish({
        type: "orca.effect.executing",
        source: this.definition.name,
        timestamp: new Date(),
        payload: { effect: effect.type },
      });

      const result = await this.eventBus.executeEffect(effect);

      if (result.status === EffectStatus.SUCCESS) {
        await this.eventBus.publish({
          type: "orca.effect.completed",
          source: this.definition.name,
          timestamp: new Date(),
          payload: { effect: effect.type, result: result.data },
        });
        if (result.data && typeof result.data === "object") {
          Object.assign(this.context, result.data as Record<string, unknown>);
        }
      } else {
        await this.eventBus.publish({
          type: "orca.effect.failed",
          source: this.definition.name,
          timestamp: new Date(),
          payload: { effect: effect.type, error: result.error },
        });
      }
    } else if (actionDef) {
      await this.executeAction(actionDef.name);
    }
  }

  private async executeExitActions(stateName: string): Promise<void> {
    const stateDef = this.findStateDef(stateName);
    if (!stateDef || !stateDef.onExit) {
      return;
    }
    await this.executeAction(stateDef.onExit);
  }

  private async executeAction(actionName: string, eventPayload?: Record<string, unknown>): Promise<void> {
    const handler = this.actionHandlers.get(actionName);
    if (!handler) {
      return; // No handler registered — skip silently
    }

    const result = await handler(this.context, eventPayload);
    if (result && typeof result === "object") {
      Object.assign(this.context, result);
    }
  }

  private startTimeoutForState(stateName: string): void {
    const stateDef = this.findStateDef(stateName);
    if (!stateDef?.timeout) {
      return;
    }

    const durationMs = parseInt(stateDef.timeout.duration, 10) * 1000;
    const target = stateDef.timeout.target;

    this.timeoutTimer = setTimeout(() => {
      this.timeoutTimer = null;
      // Fire a synthetic timeout transition
      if (this.active && this.state.leaf() === stateName) {
        this.executeTimeoutTransition(stateName, target);
      }
    }, durationMs);
  }

  private cancelTimeout(): void {
    if (this.timeoutTimer !== null) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }

  private async executeTimeoutTransition(fromState: string, target: string): Promise<void> {
    const oldState = new StateValue(this.state.value);

    // Execute exit actions
    await this.executeExitActions(fromState);

    // Update state
    if (this.isCompoundState(target)) {
      const initialChild = this.getInitialChild(target);
      this.state = new StateValue({ [target]: { [initialChild]: {} } });
    } else {
      this.state = new StateValue(target);
    }

    await this.eventBus.publish({
      type: "orca.transition.started",
      source: this.definition.name,
      timestamp: new Date(),
      payload: {
        from: oldState.toString(),
        to: target,
        trigger: "timeout",
      },
    });

    await this.executeEntryActions(target);

    // Start timeout for the new state
    this.startTimeoutForState(this.state.leaf());

    if (this.onTransition) {
      await this.onTransition(oldState, this.state);
    }

    await this.eventBus.publish({
      type: "orca.transition.completed",
      source: this.definition.name,
      timestamp: new Date(),
      payload: {
        from: oldState.toString(),
        to: this.state.toString(),
      },
    });
  }

  private findStateDef(stateName: string): StateDef | null {
    for (const state of this.definition.states) {
      if (state.name === stateName) {
        return state;
      }
      if (state.contains) {
        for (const child of state.contains) {
          if (child.name === stateName) {
            return child;
          }
        }
      }
    }
    return null;
  }

  private isEventIgnored(eventName: string): boolean {
    const current = this.state.leaf();
    const stateDef = this.findStateDef(current);
    if (stateDef?.ignoredEvents.includes(eventName)) {
      return true;
    }
    // Also check parent state's ignored events
    let parent = this.getParentState(current);
    while (parent) {
      const parentDef = this.findStateDef(parent);
      if (parentDef?.ignoredEvents.includes(eventName)) {
        return true;
      }
      parent = this.getParentState(parent);
    }
    return false;
  }

  private findActionDef(actionName: string): ActionSignature | null {
    for (const action of this.definition.actions) {
      if (action.name === actionName) {
        return action;
      }
    }
    return null;
  }
}
