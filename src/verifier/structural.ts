import { MachineDef, StateDef } from '../parser/ast.js';
import type { VerificationError, VerificationResult, StateInfo, MachineAnalysis } from './types.js';

export type { Severity } from './types.js';
export type { VerificationError, VerificationResult, StateInfo, MachineAnalysis } from './types.js';

export function analyzeMachine(machine: MachineDef): MachineAnalysis {
  const stateMap = new Map<string, StateInfo>();
  const finalStates: StateDef[] = [];
  let initialState: StateDef | null = null;

  // Initialize state info
  for (const state of machine.states) {
    stateMap.set(state.name, {
      state,
      incoming: [],
      outgoing: [],
      eventsHandled: new Set(),
      eventsIgnored: new Set(),
    });
    if (state.isFinal) finalStates.push(state);
    if (state.isInitial) initialState = state;
  }

  // Process transitions
  for (const transition of machine.transitions) {
    const sourceInfo = stateMap.get(transition.source);
    const targetInfo = stateMap.get(transition.target);
    if (sourceInfo) {
      sourceInfo.outgoing.push(transition);
      sourceInfo.eventsHandled.add(transition.event);
    }
    if (targetInfo) {
      targetInfo.incoming.push(transition);
    }
  }

  // Process ignored events from state definitions
  for (const state of machine.states) {
    const info = stateMap.get(state.name);
    if (info && state.ignoredEvents) {
      for (const event of state.ignoredEvents) {
        info.eventsIgnored.add(event);
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
    if (state.onEntry) usedActions.add(state.onEntry);
    if (state.onExit) usedActions.add(state.onExit);
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

  for (const [name, info] of stateMap) {
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
