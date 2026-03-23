import { MachineDef, StateDef, Transition } from '../parser/ast.js';

export type Severity = 'error' | 'warning';

export interface VerificationError {
  code: string;
  message: string;
  severity: Severity;
  location?: {
    state?: string;
    event?: string;
    transition?: Transition;
  };
  suggestion?: string;
}

export interface VerificationResult {
  valid: boolean;
  errors: VerificationError[];
}

export interface StateInfo {
  state: StateDef;
  incoming: Transition[];
  outgoing: Transition[];
  eventsHandled: Set<string>;
  eventsIgnored: Set<string>;
}

export interface MachineAnalysis {
  machine: MachineDef;
  stateMap: Map<string, StateInfo>;
  initialState: StateDef | null;
  finalStates: StateDef[];
  orphanEvents: string[];
  orphanActions: string[];
}
