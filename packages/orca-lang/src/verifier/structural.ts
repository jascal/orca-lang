import { MachineDef, StateDef } from '../parser/ast.js';
import type { VerificationError, VerificationResult, StateInfo, MachineAnalysis } from './types.js';

export type { Severity } from './types.js';
export type { VerificationError, VerificationResult, StateInfo, MachineAnalysis } from './types.js';

export interface FlattenedState {
  name: string;        // Full dot-notation name (e.g., "movement.walking")
  simpleName: string;  // Simple name (e.g., "walking")
  parentName?: string;  // Parent's full name (e.g., "movement")
  isCompound: boolean;  // Has nested states
  isInitial: boolean;
  isFinal: boolean;
  contains?: FlattenedState[];
}

/**
 * Recursively flatten nested states into dot-notation names.
 * E.g., "movement" with children "walking", "running" becomes:
 * - "movement" (compound)
 * - "movement.walking" (child)
 * - "movement.running" (child)
 */
export function flattenStates(states: StateDef[], parentPrefix?: string): FlattenedState[] {
  const result: FlattenedState[] = [];

  for (const state of states) {
    const fullName = parentPrefix ? `${parentPrefix}.${state.name}` : state.name;
    const isCompound = state.contains && state.contains.length > 0;

    const flattened: FlattenedState = {
      name: fullName,
      simpleName: state.name,
      parentName: parentPrefix,
      isCompound: Boolean(state.contains && state.contains.length > 0),
      isInitial: state.isInitial,
      isFinal: state.isFinal,
    };

    if (isCompound) {
      flattened.contains = flattenStates(state.contains!, fullName);
    }

    result.push(flattened);

    // Recursively flatten children
    if (isCompound) {
      result.push(...flattened.contains!);
    }
  }

  return result;
}

/**
 * Find the initial child state of a compound state.
 */
export function findInitialChild(state: FlattenedState): FlattenedState | undefined {
  if (!state.contains || state.contains.length === 0) return undefined;
  return state.contains.find(child => child.isInitial) || state.contains[0];
}

/**
 * Resolve a state name - if it's a compound state, return its initial child.
 */
export function resolveState(states: FlattenedState[], name: string): FlattenedState | undefined {
  const state = states.find(s => s.name === name);
  if (!state) return undefined;

  // If it's a compound state, return the initial child instead
  if (state.isCompound) {
    return findInitialChild(state);
  }

  return state;
}

export function analyzeMachine(machine: MachineDef): MachineAnalysis {
  const stateMap = new Map<string, StateInfo>();
  const finalStates: StateDef[] = [];
  let initialState: StateDef | null = null;

  // Flatten nested states for analysis
  const flattenedStates = flattenStates(machine.states);
  const flattenedStateMap = new Map<string, FlattenedState>();
  for (const fs of flattenedStates) {
    flattenedStateMap.set(fs.name, fs);
  }

  // Initialize state info from flattened states
  for (const fs of flattenedStates) {
    // Skip children individually - they're reached through compound states
    // But we need them in the map for reference
    stateMap.set(fs.name, {
      state: { name: fs.name, isInitial: fs.isInitial, isFinal: fs.isFinal } as StateDef,
      incoming: [],
      outgoing: [],
      eventsHandled: new Set(),
      eventsIgnored: new Set(),
    });
    if (fs.isFinal && !fs.parentName) finalStates.push({ name: fs.name, isFinal: true, isInitial: false } as StateDef);
    if (fs.isInitial && !fs.parentName) initialState = { name: fs.name, isFinal: false, isInitial: true } as StateDef;
  }

  // Process transitions - handle compound state targets
  for (const transition of machine.transitions) {
    // Find source and target states (may be compound or leaf)
    const sourceFS = flattenedStateMap.get(transition.source);
    const targetFS = flattenedStateMap.get(transition.target);

    // If target is a compound state, redirect to its initial child
    let resolvedTarget = transition.target;
    if (targetFS?.isCompound) {
      const initialChild = findInitialChild(targetFS);
      if (initialChild) {
        resolvedTarget = initialChild.name;
      }
    }

    const sourceInfo = stateMap.get(transition.source);
    const targetInfo = stateMap.get(resolvedTarget);
    if (sourceInfo) {
      sourceInfo.outgoing.push(transition);
      sourceInfo.eventsHandled.add(transition.event);
    }
    if (targetInfo) {
      targetInfo.incoming.push(transition);
    }
  }

  // Process ignored events from state definitions (check flattened map)
  for (const [name, info] of stateMap) {
    const fs = flattenedStateMap.get(name);
    if (fs) {
      // Find the original state definition
      const originalState = findOriginalState(machine.states, fs.simpleName, fs.parentName);
      if (originalState?.ignoredEvents) {
        for (const event of originalState.ignoredEvents) {
          info.eventsIgnored.add(event);
        }
      }
    }
  }

  // Find orphan events and actions
  const usedEvents = new Set<string>();
  const usedActions = new Set<string>();

  // Actions referenced in transitions
  for (const t of machine.transitions) {
    usedEvents.add(t.event);
    if (t.action) usedActions.add(t.action);
  }

  // Actions referenced in state on_entry/on_exit
  for (const state of machine.states) {
    collectActionsFromState(state, usedActions);
  }

  const orphanEvents = machine.events.filter(e => !usedEvents.has(e.name)).map(e => e.name);
  const orphanActions = machine.actions.filter(a => !usedActions.has(a.name)).map(a => a.name);

  return {
    machine,
    stateMap,
    initialState,
    finalStates,
    orphanEvents,
    orphanActions,
  };
}

// Helper to find original state in nested structure
function findOriginalState(states: StateDef[], name: string, parentName?: string): StateDef | undefined {
  if (!parentName) {
    return states.find(s => s.name === name);
  }

  for (const state of states) {
    if (state.contains) {
      if (state.name === parentName) {
        return state.contains.find(s => s.name === name);
      }
      const found = findOriginalState(state.contains, name, parentName);
      if (found) return found;
    }
  }
  return undefined;
}

// Helper to collect actions from state and nested states
function collectActionsFromState(state: StateDef, actions: Set<string>): void {
  if (state.onEntry) actions.add(state.onEntry);
  if (state.onExit) actions.add(state.onExit);
  if (state.contains) {
    for (const child of state.contains) {
      collectActionsFromState(child, actions);
    }
  }
}

export function checkReachability(analysis: MachineAnalysis): VerificationError[] {
  const errors: VerificationError[] = [];
  const { stateMap, initialState } = analysis;

  if (!initialState) {
    errors.push({
      code: 'NO_INITIAL_STATE',
      message: 'Machine has no initial state',
      severity: 'error',
      suggestion: 'Mark one state with [initial] annotation',
    });
    return errors;
  }

  const visited = new Set<string>();
  const queue = [initialState.name];

  while (queue.length > 0) {
    const name = queue.shift()!;
    if (visited.has(name)) continue;
    visited.add(name);

    const info = stateMap.get(name);
    if (!info) continue;

    for (const t of info.outgoing) {
      if (!visited.has(t.target)) {
        queue.push(t.target);
      }
    }
  }

  for (const state of analysis.machine.states) {
    if (!visited.has(state.name)) {
      errors.push({
        code: 'UNREACHABLE_STATE',
        message: `State '${state.name}' is unreachable from initial state '${initialState.name}'`,
        severity: 'error',
        location: { state: state.name },
        suggestion: `Add a transition that reaches '${state.name}'`,
      });
    }
  }

  return errors;
}

export function checkDeadlocks(analysis: MachineAnalysis): VerificationError[] {
  const errors: VerificationError[] = [];
  const { stateMap, finalStates } = analysis;
  const finalStateNames = new Set(finalStates.map(s => s.name));

  // Build a set of compound state names and child state names
  const compoundStates = new Set<string>();
  const childStates = new Set<string>();

  for (const [name, info] of stateMap) {
    // If state name has a dot, it's a child of a compound state
    if (name.includes('.')) {
      childStates.add(name);
      const parentName = name.split('.')[0];
      compoundStates.add(parentName);
    }
  }

  for (const [name, info] of stateMap) {
    // Skip child states - they're controlled by parent transitions
    if (childStates.has(name)) {
      continue;
    }

    // Skip compound states (parents) - they delegate to children
    if (compoundStates.has(name)) {
      continue;
    }

    // Final states should have no outgoing transitions (except self-loops for ignored events)
    if (finalStateNames.has(name)) {
      const realOutgoing = info.outgoing.filter(t => t.target !== name);
      if (realOutgoing.length > 0) {
        errors.push({
          code: 'FINAL_STATE_OUTGOING',
          message: `Final state '${name}' has outgoing transitions`,
          severity: 'error',
          location: { state: name },
          suggestion: 'Remove transitions from final states or remove [final] marker',
        });
      }
    } else {
      // Non-final states must have outgoing transitions
      if (info.outgoing.length === 0) {
        errors.push({
          code: 'DEADLOCK',
          message: `Non-final state '${name}' has no outgoing transitions`,
          severity: 'error',
          location: { state: name },
          suggestion: `Add transitions from '${name}' or mark it as [final]`,
        });
      }
    }
  }

  return errors;
}

export function checkOrphans(analysis: MachineAnalysis): VerificationError[] {
  const errors: VerificationError[] = [];

  for (const event of analysis.orphanEvents) {
    errors.push({
      code: 'ORPHAN_EVENT',
      message: `Event '${event}' is declared but never used in any transition`,
      severity: 'warning',
      suggestion: `Use '${event}' in a transition or remove it from the events declaration`,
    });
  }

  for (const action of analysis.orphanActions) {
    errors.push({
      code: 'ORPHAN_ACTION',
      message: `Action '${action}' is declared but never referenced in any transition`,
      severity: 'warning',
      suggestion: `Reference '${action}' in a transition or remove it from the actions declaration`,
    });
  }

  return errors;
}

export function checkStructural(machine: MachineDef): VerificationResult {
  const analysis = analyzeMachine(machine);
  const errors: VerificationError[] = [
    ...checkReachability(analysis),
    ...checkDeadlocks(analysis),
    ...checkOrphans(analysis),
  ];

  return {
    valid: errors.filter(e => e.severity === 'error').length === 0,
    errors,
  };
}
