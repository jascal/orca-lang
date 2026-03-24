/**
 * Core type definitions for Orca TypeScript runtime.
 */

export type Context = Record<string, unknown>;

export interface StateDef {
  name: string;
  isInitial: boolean;
  isFinal: boolean;
  onEntry?: string;
  onExit?: string;
  description?: string;
  contains: StateDef[];
  parent?: string;
  timeout?: { duration: string; target: string };
  ignoredEvents: string[];
}

export interface Transition {
  source: string;
  event: string;
  target: string;
  guard?: string;
  action?: string;
}

export interface GuardDef {
  name: string;
  expression: GuardExpression;
}

export interface ActionSignature {
  name: string;
  parameters: string[];
  returnType: string;
  hasEffect: boolean;
  effectType?: string;
}

export interface MachineDef {
  name: string;
  context: Context;
  events: string[];
  states: StateDef[];
  transitions: Transition[];
  guards: Record<string, GuardExpression>;
  actions: ActionSignature[];
}

export type GuardExpression =
  | GuardTrue
  | GuardFalse
  | GuardCompare
  | GuardAnd
  | GuardOr
  | GuardNot
  | GuardNullcheck;

export interface GuardTrue {
  kind: "true";
}

export interface GuardFalse {
  kind: "false";
}

export interface GuardCompare {
  kind: "compare";
  op: "eq" | "ne" | "lt" | "gt" | "le" | "ge";
  left: VariableRef;
  right: ValueRef;
}

export interface GuardAnd {
  kind: "and";
  left: GuardExpression;
  right: GuardExpression;
}

export interface GuardOr {
  kind: "or";
  left: GuardExpression;
  right: GuardExpression;
}

export interface GuardNot {
  kind: "not";
  expr: GuardExpression;
}

export interface GuardNullcheck {
  kind: "nullcheck";
  expr: VariableRef;
  isNull: boolean;
}

export interface VariableRef {
  kind: "variable";
  path: string[];
}

export interface ValueRef {
  kind: "value";
  type: "string" | "number" | "boolean" | "null";
  value: string | number | boolean | null;
}

export interface Effect {
  type: string;
  payload: Record<string, unknown>;
}

export interface EffectResult {
  status: EffectStatus;
  data?: unknown;
  error?: string;
}

export const EffectStatus = {
  SUCCESS: "success",
  FAILURE: "failure",
} as const;

export type EffectStatus = (typeof EffectStatus)[keyof typeof EffectStatus];

export class StateValue {
  constructor(public value: string | Record<string, unknown>) {}

  toString(): string {
    if (typeof this.value === "string") {
      return this.value;
    }
    return this.formatCompound();
  }

  private formatCompound(): string {
    if (typeof this.value === "string") {
      return this.value;
    }

    const formatRecursive = (
      d: Record<string, unknown>,
      prefix = ""
    ): string => {
      const parts: string[] = [];
      for (const [key, val] of Object.entries(d)) {
        if (typeof val === "object" && val !== null && Object.keys(val).length > 0) {
          parts.push(formatRecursive(val as Record<string, unknown>, prefix + key + "."));
        } else {
          parts.push(prefix + key);
        }
      }
      return parts.length > 0 ? parts.join(", ") : JSON.stringify(d);
    };

    return formatRecursive(this.value);
  }

  isCompound(): boolean {
    return typeof this.value === "object" && this.value !== null;
  }

  leaf(): string {
    if (typeof this.value === "string") {
      return this.value;
    }

    for (const [key, val] of Object.entries(this.value)) {
      if (typeof val === "object" && val !== null && Object.keys(val).length > 0) {
        const result = new StateValue(val as string | Record<string, unknown>).leaf();
        if (result) {
          return result;
        }
      } else {
        return key;
      }
    }

    return String(this.value);
  }

  parentNames(): string[] {
    if (typeof this.value === "object" && this.value !== null) {
      return Object.keys(this.value);
    }
    return [];
  }

  equals(other: StateValue | string | Record<string, unknown>): boolean {
    if (other instanceof StateValue) {
      return this.value === other.value;
    }
    if (typeof other === "string") {
      return this.value === other;
    }
    if (typeof other === "object" && other !== null) {
      return this.value === other;
    }
    return false;
  }
}
