import { MachineDef, StateDef, OrcaFile } from '../parser/ast.js';
import type { VerificationError, VerificationResult, StateInfo, MachineAnalysis, FileAnalysis } from './types.js';

export type { Severity } from './types.js';
export type { VerificationError, VerificationResult, StateInfo, MachineAnalysis } from './types.js';

export interface FlattenedState {
  name: string;        // Full dot-notation name (e.g., "movement.walking")
  simpleName: string;  // Simple name (e.g., "walking")
  parentName?: string;  // Parent's full name (e.g., "movement")
  isCompound: boolean;  // Has nested states
  isParallel: boolean;  // Has parallel regions
  isRegion: boolean;    // Is a region container
  isInitial: boolean;
  isFinal: boolean;
  contains?: FlattenedState[];
  regionOf?: string;    // Parent parallel state name
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
    const isParallel = Boolean(state.parallel);

    const flattened: FlattenedState = {
      name: fullName,
      simpleName: state.name,
      parentName: parentPrefix,
      isCompound: Boolean(isCompound || isParallel),
      isParallel,
      isRegion: false,
      isInitial: state.isInitial,
      isFinal: state.isFinal,
    };

    if (isCompound) {
      flattened.contains = flattenStates(state.contains!, fullName);
    }

    result.push(flattened);

    // Recursively flatten hierarchical children
    if (isCompound) {
      result.push(...flattened.contains!);
    }

    // Flatten parallel regions
    if (state.parallel) {
      const regionChildren: FlattenedState[] = [];
      for (const region of state.parallel.regions) {
        const regionFullName = `${fullName}.${region.name}`;
        const regionFlattened: FlattenedState = {
          name: regionFullName,
          simpleName: region.name,
          parentName: fullName,
          isCompound: true,
          isParallel: false,
          isRegion: true,
          isInitial: false,
          isFinal: false,
          regionOf: fullName,
          contains: flattenStates(region.states, regionFullName),
        };
        result.push(regionFlattened);
        result.push(...regionFlattened.contains!);
        regionChildren.push(regionFlattened);
      }
      flattened.contains = regionChildren;
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
    if (targetFS?.isCompound && !targetFS?.isParallel) {
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

  // Process onDone transitions for parallel states
  for (const state of machine.states) {
    if (state.parallel && state.onDone) {
      const syntheticTransition = {
        source: state.name,
        event: '__onDone__',
        target: state.onDone,
      };
      const sourceInfo = stateMap.get(state.name);
      const targetInfo = stateMap.get(state.onDone);
      if (sourceInfo) {
        sourceInfo.outgoing.push(syntheticTransition);
      }
      if (targetInfo) {
        targetInfo.incoming.push(syntheticTransition);
      }
    }
  }

  // Process ignored events from state definitions (check flattened map)
  for (const [name, info] of stateMap) {
    const fs = flattenedStateMap.get(name);
    if (fs) {
      // Find the original state definition
      const originalState = findOriginalState(machine.states, fs.simpleName, fs.parentName);
      if (originalState?.ignoredAll) {
        for (const event of machine.events) {
          info.eventsIgnored.add(event.name);
        }
      } else if (originalState?.ignoredEvents) {
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

  // Orphan effects: declared in ## effects but no action references them via effectType
  const usedEffectTypes = new Set<string>(
    machine.actions.filter(a => a.hasEffect && a.effectType).map(a => a.effectType!)
  );
  const orphanEffects = machine.effects
    ? machine.effects.filter(e => !usedEffectTypes.has(e.name)).map(e => e.name)
    : [];

  return {
    machine,
    stateMap,
    initialState,
    finalStates,
    orphanEvents,
    orphanActions,
    orphanEffects,
  };
}

// Helper to find original state in nested structure (including parallel regions)
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
    if (state.parallel) {
      for (const region of state.parallel.regions) {
        // Check if parentName matches "stateName.regionName"
        const regionFullName: string = `${state.name}.${region.name}`;
        if (regionFullName === parentName) {
          return region.states.find(s => s.name === name);
        }
        // Recurse into region states
        const found = findOriginalState(region.states, name, parentName);
        if (found) return found;
      }
    }
  }
  return undefined;
}

// Helper to collect actions from state and nested states (including parallel regions)
function collectActionsFromState(state: StateDef, actions: Set<string>): void {
  if (state.onEntry) actions.add(state.onEntry);
  if (state.onExit) actions.add(state.onExit);
  if (state.contains) {
    for (const child of state.contains) {
      collectActionsFromState(child, actions);
    }
  }
  if (state.parallel) {
    for (const region of state.parallel.regions) {
      for (const child of region.states) {
        collectActionsFromState(child, actions);
      }
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

  for (const effect of analysis.orphanEffects) {
    errors.push({
      code: 'ORPHAN_EFFECT',
      message: `Effect '${effect}' is declared but never referenced by any action`,
      severity: 'warning',
      suggestion: `Reference '${effect}' in an action signature or remove it from the effects declaration`,
    });
  }

  // Undeclared effects: actions reference an effectType not in ## effects
  // Only checked when the ## effects section is explicitly present
  if (analysis.machine.effects !== undefined) {
    const declaredEffects = new Set(analysis.machine.effects.map(e => e.name));
    for (const action of analysis.machine.actions) {
      if (action.hasEffect && action.effectType && !declaredEffects.has(action.effectType)) {
        errors.push({
          code: 'UNDECLARED_EFFECT',
          message: `Action '${action.name}' references effect '${action.effectType}' which is not declared in ## effects`,
          severity: 'warning',
          suggestion: `Add '${action.effectType}' to the ## effects section or remove the effect reference`,
        });
      }
    }
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

// ============================================================
// Cross-Machine Analysis (for multi-machine files)
// ============================================================

const MAX_TOTAL_STATES = 64;

/**
 * Build a map of machine name -> list of machines it invokes
 */
function buildInvocationGraph(file: OrcaFile): Map<string, string[]> {
  const graph = new Map<string, string[]>();

  for (const machine of file.machines) {
    const invoked: string[] = [];
    collectInvocations(machine.states, invoked);
    graph.set(machine.name, invoked);
  }

  return graph;
}

function collectInvocations(states: StateDef[], result: string[]): void {
  for (const state of states) {
    if (state.invoke) {
      result.push(state.invoke.machine);
    }
    if (state.contains) {
      collectInvocations(state.contains, result);
    }
    if (state.parallel) {
      for (const region of state.parallel.regions) {
        collectInvocations(region.states, result);
      }
    }
  }
}

/**
 * Detect cycles in the invocation graph using DFS.
 * Returns an array of machine names forming a cycle, or empty if no cycle.
 */
function detectCycle(graph: Map<string, string[]>, machine: string, visited: Set<string>, path: string[]): string[] {
  visited.add(machine);
  path.push(machine);

  const invoked = graph.get(machine) || [];
  for (const child of invoked) {
    if (path.includes(child)) {
      // Found cycle - return the cycle starting from the child
      const cycleStart = path.indexOf(child);
      return [...path.slice(cycleStart), child];
    }
    if (!visited.has(child)) {
      const cycle = detectCycle(graph, child, visited, [...path]);
      if (cycle.length > 0) return cycle;
    }
  }

  return [];
}

/**
 * Check that a machine can reach a final state.
 */
function canReachFinalState(machine: MachineDef, visited: Set<string> = new Set()): boolean {
  if (visited.has(machine.name)) return false;  // Prevent infinite recursion
  visited.add(machine.name);

  // Check if machine has any final states
  const finalStateNames = new Set<string>();
  collectFinalStates(machine.states, finalStateNames);

  if (finalStateNames.size === 0) return false;

  // Build transition map for reachability check
  const transitionMap = new Map<string, Set<string>>();
  for (const t of machine.transitions) {
    if (!transitionMap.has(t.source)) {
      transitionMap.set(t.source, new Set());
    }
    transitionMap.get(t.source)!.add(t.target);
  }

  // BFS from initial state to see if we can reach any final state
  const initialState = machine.states.find(s => s.isInitial);
  if (!initialState) return false;

  const queue = [initialState.name];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);

    if (finalStateNames.has(current)) return true;

    const targets = transitionMap.get(current);
    if (targets) {
      for (const target of targets) {
        if (!seen.has(target)) {
          queue.push(target);
        }
      }
    }
  }

  return false;
}

function collectFinalStates(states: StateDef[], result: Set<string>): void {
  for (const state of states) {
    if (state.isFinal) {
      result.add(state.name);
    }
    if (state.contains) {
      collectFinalStates(state.contains, result);
    }
    if (state.parallel) {
      for (const region of state.parallel.regions) {
        collectFinalStates(region.states, result);
      }
    }
  }
}

/**
 * Validate input field mappings - fields must exist in parent context
 */
function validateInputMappings(
  file: OrcaFile,
  machineMap: Map<string, MachineDef>,
  errors: VerificationError[],
  warnings: VerificationError[]
): void {
  for (const machine of file.machines) {
    const contextFields = new Set(machine.context.map(c => c.name));

    // Also check for ctx.field references in transitions that might give us field names
    for (const t of machine.transitions) {
      if (t.guard) {
        // Guard references might use context fields
        // For now we just validate explicit input mappings
      }
    }

    // Check invoke input mappings
    validateInvokeInputs(machine.states, machine.name, contextFields, errors, warnings);
  }
}

function validateInvokeInputs(
  states: StateDef[],
  machineName: string,
  contextFields: Set<string>,
  errors: VerificationError[],
  warnings: VerificationError[]
): void {
  for (const state of states) {
    if (state.invoke?.input) {
      for (const [childField, parentField] of Object.entries(state.invoke.input)) {
        // parentField is like "ctx.order_id" or just "order_id"
        const fieldName = parentField.replace(/^ctx\./, '');
        if (!contextFields.has(fieldName)) {
          errors.push({
            code: 'INVALID_INPUT_MAPPING',
            message: `Machine '${machineName}' state '${state.name}': input mapping references '${fieldName}' which does not exist in context`,
            severity: 'error',
            location: { state: state.name },
            suggestion: `Add '${fieldName}' to the context declaration or use an existing field`,
          });
        }
      }
    }
    if (state.contains) {
      validateInvokeInputs(state.contains, machineName, contextFields, errors, warnings);
    }
    if (state.parallel) {
      for (const region of state.parallel.regions) {
        validateInvokeInputs(region.states, machineName, contextFields, errors, warnings);
      }
    }
  }
}

/**
 * Analyze an entire OrcaFile with multiple machines.
 * Performs cross-machine validation including:
 * - Machine resolution (invoke.machine must exist)
 * - Circular invocation detection
 * - Child reachability to final state
 * - onDone/onError event validation
 * - Missing on_error warning
 * - Combined state budget
 * - Input field validation
 */
export function analyzeFile(file: OrcaFile): FileAnalysis {
  const errors: VerificationError[] = [];
  const warnings: VerificationError[] = [];

  const machineMap = new Map<string, MachineDef>();
  for (const machine of file.machines) {
    machineMap.set(machine.name, machine);
  }

  // Build invocation graph
  const invocationGraph = buildInvocationGraph(file);

  // Check total state count
  let totalStates = 0;
  for (const machine of file.machines) {
    const stateCount = countStates(machine.states);
    totalStates += stateCount;
  }

  if (totalStates > MAX_TOTAL_STATES) {
    errors.push({
      code: 'STATE_LIMIT_EXCEEDED',
      message: `Combined state count (${totalStates}) exceeds limit of ${MAX_TOTAL_STATES}`,
      severity: 'error',
      suggestion: 'Split machines into separate files or reduce state count',
    });
  }

  // Analyze each machine
  const analyses = new Map<string, MachineAnalysis>();
  for (const machine of file.machines) {
    analyses.set(machine.name, analyzeMachine(machine));
  }

  // Check for cycles
  const visited = new Set<string>();
  for (const machine of file.machines) {
    if (!visited.has(machine.name)) {
      const cycle = detectCycle(invocationGraph, machine.name, visited, []);
      if (cycle.length > 0) {
        errors.push({
          code: 'CIRCULAR_INVOCATION',
          message: `Circular invocation detected: ${cycle.join(' -> ')}`,
          severity: 'error',
          suggestion: 'Remove the circular invocation chain',
        });
      }
    }
  }

  // Check each invoke
  for (const machine of file.machines) {
    const eventNames = new Set(machine.events.map(e => e.name));
    checkInvocations(machine.states, machine.name, machineMap, eventNames, errors, warnings);
  }

  // Validate input mappings
  validateInputMappings(file, machineMap, errors, warnings);

  return {
    machines: analyses,
    invocationGraph,
    errors,
    warnings,
  };
}

function checkInvocations(
  states: StateDef[],
  machineName: string,
  machineMap: Map<string, MachineDef>,
  eventNames: Set<string>,
  errors: VerificationError[],
  warnings: VerificationError[]
): void {
  for (const state of states) {
    if (state.invoke) {
      const invokedMachine = state.invoke.machine;

      // Check machine exists
      if (!machineMap.has(invokedMachine)) {
        errors.push({
          code: 'UNKNOWN_MACHINE',
          message: `Machine '${machineName}' state '${state.name}': invokes unknown machine '${invokedMachine}'`,
          severity: 'error',
          location: { state: state.name },
          suggestion: `Define a machine named '${invokedMachine}' in the same file`,
        });
      } else {
        // Check child can reach final state
        const childMachine = machineMap.get(invokedMachine)!;
        if (!canReachFinalState(childMachine)) {
          errors.push({
            code: 'CHILD_NO_FINAL_STATE',
            message: `Machine '${machineName}' state '${state.name}': invoked machine '${invokedMachine}' has no reachable final state`,
            severity: 'error',
            location: { state: state.name },
            suggestion: `Add at least one final state to '${invokedMachine}'`,
          });
        }
      }

      // Check onDone event exists in parent's events
      if (state.invoke.onDone && !eventNames.has(state.invoke.onDone)) {
        errors.push({
          code: 'UNKNOWN_ON_DONE_EVENT',
          message: `Machine '${machineName}' state '${state.name}': on_done references event '${state.invoke.onDone}' which is not declared`,
          severity: 'error',
          location: { state: state.name },
          suggestion: `Add '${state.invoke.onDone}' to the events declaration`,
        });
      }

      // Check onError event exists in parent's events
      if (state.invoke.onError && !eventNames.has(state.invoke.onError)) {
        errors.push({
          code: 'UNKNOWN_ON_ERROR_EVENT',
          message: `Machine '${machineName}' state '${state.name}': on_error references event '${state.invoke.onError}' which is not declared`,
          severity: 'error',
          location: { state: state.name },
          suggestion: `Add '${state.invoke.onError}' to the events declaration`,
        });
      }

      // Warn if no onError (potential deadlock on child error)
      if (!state.invoke.onError) {
        warnings.push({
          code: 'MISSING_ON_ERROR',
          message: `Machine '${machineName}' state '${state.name}': invoke has no on_error handler - child errors will cause deadlock`,
          severity: 'warning',
          location: { state: state.name },
          suggestion: `Add on_error: EVENT to handle child machine failures`,
        });
      }
    }

    if (state.contains) {
      checkInvocations(state.contains, machineName, machineMap, eventNames, errors, warnings);
    }
    if (state.parallel) {
      for (const region of state.parallel.regions) {
        checkInvocations(region.states, machineName, machineMap, eventNames, errors, warnings);
      }
    }
  }
}

function countStates(states: StateDef[]): number {
  let count = states.length;
  for (const state of states) {
    if (state.contains) {
      count += countStates(state.contains);
    }
    if (state.parallel) {
      for (const region of state.parallel.regions) {
        count += countStates(region.states);
      }
    }
  }
  return count;
}
