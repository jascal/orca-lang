import { MachineDef, Transition, ActionSignature, StateDef } from '../parser/ast.js';
import { createMachine, assign } from 'xstate';

// Helper to find a state with a specific action (searches nested states)
function findStateByAction(machine: MachineDef, actionName: string): StateDef | undefined {
  for (const state of machine.states) {
    const found = findStateRecursively(state, actionName);
    if (found) return found;
  }
  return undefined;
}

function findStateRecursively(state: StateDef, actionName: string): StateDef | undefined {
  if (state.onEntry === actionName || state.onExit === actionName) {
    return state;
  }
  if (state.contains) {
    for (const child of state.contains) {
      const found = findStateRecursively(child, actionName);
      if (found) return found;
    }
  }
  if (state.parallel) {
    for (const region of state.parallel.regions) {
      for (const child of region.states) {
        const found = findStateRecursively(child, actionName);
        if (found) return found;
      }
    }
  }
  return undefined;
}

export interface CompiledMachine {
  config: any; // XState MachineConfig type
  effectMeta: {
    effectfulActions: Array<{
      name: string;
      effectType: string;
      state: string;
      transition?: string;
    }>;
  };
}

export function compileToXStateMachine(machine: MachineDef): CompiledMachine {
  const effectMeta = {
    effectfulActions: findEffectfulActions(machine),
  };

  const config: any = {
    id: machine.name,
    types: {
      context: {} as any,
      events: {} as any,
    },
    context: buildContext(machine),
    initial: getInitialState(machine),
    states: buildStates(machine),
  };

  return { config, effectMeta };
}

function findEffectfulActions(machine: MachineDef) {
  const effectful: CompiledMachine['effectMeta']['effectfulActions'] = [];

  for (const action of machine.actions) {
    if (action.hasEffect && action.effectType) {
      // Find which state uses this action (search all states including nested)
      const stateWithAction = findStateByAction(machine, action.name);
      if (stateWithAction) {
        effectful.push({ name: action.name, effectType: action.effectType, state: stateWithAction.name });
      }
      // Find transitions using this action
      for (const t of machine.transitions) {
        if (t.action === action.name) {
          effectful.push({ name: action.name, effectType: action.effectType, state: t.source, transition: t.target });
        }
      }
    }
  }

  return effectful;
}

function buildContext(machine: MachineDef): Record<string, unknown> {
  const ctx: Record<string, unknown> = {};
  for (const field of machine.context) {
    ctx[field.name] = field.defaultValue !== undefined
      ? field.defaultValue
      : getDefaultForType(field);
  }
  return ctx;
}

function buildStates(machine: MachineDef): Record<string, any> {
  const states: Record<string, any> = {};

  for (const state of machine.states) {
    states[state.name] = buildStateConfig(state, machine, machine.states);
  }

  return states;
}

function buildStateConfig(state: StateDef, machine: MachineDef, allStates: StateDef[]): any {
  const config: any = {};

  if (state.description) {
    config.description = state.description;
  }

  // Check if this is a compound state (has nested states)
  if (state.contains && state.contains.length > 0) {
    // Compound state with nested states
    const initialChild = state.contains.find(s => s.isInitial) || state.contains[0];
    config.initial = initialChild.name;
    config.states = {};

    // Handle transitions for compound states (BEFORE recursive calls)
    // These transitions fire from any child state via XState event bubbling
    const thisStateTransitions = machine.transitions.filter(t => t.source === state.name);
    if (thisStateTransitions.length > 0) {
      config.on = buildTransitions(thisStateTransitions, machine);
    }

    for (const child of state.contains) {
      config.states[child.name] = buildStateConfig(child, machine, state.contains);
    }

    // Compound states don't use type: 'initial' or 'final' - they use initial + nested states
    return config;
  }

  // Check if this is a parallel state (has parallel regions)
  if (state.parallel) {
    config.type = 'parallel';
    config.states = {};

    for (const region of state.parallel.regions) {
      const regionConfig: any = {};
      const initialChild = region.states.find(s => s.isInitial) || region.states[0];
      regionConfig.initial = initialChild.name;
      regionConfig.states = {};

      for (const child of region.states) {
        regionConfig.states[child.name] = buildStateConfig(child, machine, region.states);
      }

      config.states[region.name] = regionConfig;
    }

    // onDone for synchronization (all-final is the XState default)
    if (state.onDone) {
      config.onDone = { target: state.onDone };
    }

    // Parent-level transitions (event bubbling to all regions)
    const thisStateTransitions = machine.transitions.filter(t => t.source === state.name);
    if (thisStateTransitions.length > 0) {
      config.on = buildTransitions(thisStateTransitions, machine);
    }

    return config;
  }

  // Leaf state configuration
  // Note: initial state is designated by the parent's `initial` property, not by type
  if (state.isFinal) {
    config.type = 'final';
  }
  if (state.onEntry) {
    const action = machine.actions.find(a => a.name === state.onEntry);
    if (action?.hasEffect) {
      // Effectful action - use invoke at state level to run the effect
      // Don't set entry - the invoke replaces the entry action
      config.invoke = buildEffectInvoke(state.onEntry, action, machine);
    } else {
      config.entry = state.onEntry;
    }
  }
  if (state.onExit) {
    config.exit = state.onExit;
  }

  // Handle machine invocation
  if (state.invoke) {
    config.invoke = buildMachineInvoke(state.invoke);
  }

  // Handle transitions - only use this state's transitions
  // (transitions on compound states fire from any child via XState's event bubbling)
  const thisStateTransitions = machine.transitions.filter(t => t.source === state.name);

  if (thisStateTransitions.length > 0) {
    config.on = buildTransitions(thisStateTransitions, machine);
  }

  // Handle timeout
  if (state.timeout) {
    config.after = {
      [state.timeout.duration]: { target: state.timeout.target },
    };
  }

  return config;
}

// Get transitions from parent compound states (these fire from any child state)
function getParentTransitions(state: StateDef, machine: MachineDef, allStates: StateDef[]): Transition[] {
  if (!state.parent) return [];

  // Find parent state
  const parent = findStateByName(allStates, state.parent);
  if (!parent) return [];

  // Get parent's transitions
  const parentTransitions = machine.transitions.filter(t => t.source === parent.name);

  // Recursively get grandparent transitions
  const grandparentTransitions = getParentTransitions(parent, machine, allStates);

  return [...parentTransitions, ...grandparentTransitions];
}

// Find a state by name in a flat list of states (including nested and parallel regions)
function findStateByName(states: StateDef[], name: string): StateDef | undefined {
  for (const state of states) {
    if (state.name === name) return state;
    if (state.contains) {
      const found = findStateByName(state.contains, name);
      if (found) return found;
    }
    if (state.parallel) {
      for (const region of state.parallel.regions) {
        const found = findStateByName(region.states, name);
        if (found) return found;
      }
    }
  }
  return undefined;
}

function buildEffectInvoke(actionName: string, action: ActionSignature, machine: MachineDef): any {
  // Find the state that has this action as entry or exit
  // Search all states including nested ones
  const stateWithAction = findStateByAction(machine, actionName);
  const stateName = stateWithAction?.name;
  let doneTarget: string | undefined;

  // Find transitions from this state to determine the completion target.
  // When an effect is invoked, the machine waits for the effect to complete.
  // The completion event is derived from transitions that exit this state.
  if (stateName) {
    // Look for transitions that exit this state (these handle effect completion)
    const exitTransitions = machine.transitions.filter(t => t.source === stateName);
    if (exitTransitions.length > 0) {
      // Use the first exit transition's target as the done target.
      // This assumes effects have a simple completion path.
      doneTarget = exitTransitions[0].target;
    }
  }

  const effectType = action.effectType || 'Effect';

  // Build the input expression - it will be used in the fromPromise
  const inputExpr = ({ context, event }: { context: any; event: any }) => ({ context, event, action: actionName });

  // Find an error/failed state if one exists
  const errorState = machine.states.find(s => s.name === 'error')
    || machine.states.find(s => s.name === 'failed');
  const errorTarget = errorState?.name;

  // Return the invoke config directly, not wrapped in another object.
  const invokeConfig: any = {
    src: `__effect__:${effectType}`,
    input: inputExpr,
    onDone: doneTarget ? {
      target: doneTarget,
      actions: assign({
        _effectResult: ({ event }: any) => event.output,
      }),
    } : {
      actions: assign({
        _effectResult: ({ event }: any) => event.output,
      }),
    },
    onError: {
      actions: assign({
        _effectError: ({ event }: any) => event.error?.message,
      }),
    },
  };

  if (errorTarget) {
    invokeConfig.onError.target = errorTarget;
  }

  return invokeConfig;
}

function buildMachineInvoke(invokeDef: { machine: string; input?: Record<string, string>; onDone?: string; onError?: string }): any {
  // Build input expression from input mapping
  // input is like { id: "ctx.order_id" } -> { id: context.order_id }
  const inputExpr = ({ context, event }: { context: any; event: any }) => {
    const input: Record<string, unknown> = {};
    if (invokeDef.input) {
      for (const [key, value] of Object.entries(invokeDef.input)) {
        // value is like "ctx.order_id" - extract the field name
        const fieldName = value.replace(/^ctx\./, '');
        input[key] = context[fieldName];
      }
    }
    return input;
  };

  const invokeConfig: any = {
    src: `__machine__:${invokeDef.machine}`,
    input: inputExpr,
  };

  if (invokeDef.onDone) {
    invokeConfig.onDone = { target: invokeDef.onDone };
  }

  if (invokeDef.onError) {
    invokeConfig.onError = { target: invokeDef.onError };
  }

  return invokeConfig;
}

function buildTransitions(transitions: Transition[], machine: MachineDef): Record<string, any> {
  const on: Record<string, any> = {};
  const eventGroups = groupByEvent(transitions);

  for (const [eventName, trans] of Object.entries(eventGroups)) {
    if (trans.length === 1 && !trans[0].guard) {
      // Single unguarded transition
      const t = trans[0];
      const action = machine.actions.find(a => a.name === t.action);

      if (action?.hasEffect) {
        // Effectful transition
        on[eventName] = {
          target: t.target,
          actions: {
            type: 'effectful',
            name: t.action,
            effectType: action.effectType,
          },
        };
      } else {
        on[eventName] = {
          target: t.target,
          actions: t.action || undefined,
        };
      }
    } else {
      // Multiple transitions or guarded - use array format
      on[eventName] = trans.map(t => {
        const action = machine.actions.find(a => a.name === t.action);
        const target = t.target;

        const transition: any = { target };
        if (t.guard) {
          const guardName = t.guard.negated ? `!${t.guard.name}` : t.guard.name;
          transition.guard = { type: guardName };
        }
        if (t.action) {
          transition.actions = t.action;
        }

        return transition;
      });
    }
  }

  return on;
}

export function compileToXState(machine: MachineDef): string {
  const lines: string[] = [];

  lines.push(`import { createMachine, assign } from 'xstate';`);
  lines.push(``);
  lines.push(`export const ${machine.name}Machine = createMachine({`);
  lines.push(`  id: '${machine.name}',`);
  lines.push(`  types: {} as {`);
  lines.push(`    context: {`);
  for (const field of machine.context) {
    lines.push(`      ${field.name}: ${typeToTs(field)},`);
  }
  lines.push(`    },`);
  lines.push(`    events: |`);
  for (let i = 0; i < machine.events.length; i++) {
    const event = machine.events[i];
    lines.push(`      | { type: '${event.name}' }${i < machine.events.length - 1 ? '' : ''}`);
  }
  lines.push(`  },`);
  lines.push(`  context: {`);
  for (const field of machine.context) {
    const defaultVal = field.defaultValue || getDefaultForType(field);
    lines.push(`    ${field.name}: ${defaultVal},`);
  }
  lines.push(`  },`);
  lines.push(`  initial: '${getInitialState(machine)}',`);
  lines.push(`  states: {`);

  for (let i = 0; i < machine.states.length; i++) {
    const state = machine.states[i];
    lines.push(`    ${state.name}: {`);
    if (state.description) {
      lines.push(`      description: '${escapeString(state.description)}',`);
    }

    // Check if this is a compound state (has nested states)
    if (state.contains && state.contains.length > 0) {
      // Compound state with nested states
      const initialChild = state.contains.find(s => s.isInitial) || state.contains[0];
      lines.push(`      initial: '${initialChild.name}',`);
      lines.push(`      states: {`);
      for (let j = 0; j < state.contains.length; j++) {
        const child = state.contains[j];
        lines.push(`        ${child.name}: {`);
        if (child.description) {
          lines.push(`          description: '${escapeString(child.description)}',`);
        }
        if (child.isFinal) {
          lines.push(`          type: 'final',`);
        }
        lines.push(`        }${j < state.contains.length - 1 ? ',' : ''}`);
      }
      lines.push(`      },`);
      lines.push(`    }${i < machine.states.length - 1 ? ',' : ''}`);
      continue;
    }

    // Check if this is a parallel state
    if (state.parallel) {
      lines.push(`      type: 'parallel',`);
      lines.push(`      states: {`);
      for (let r = 0; r < state.parallel.regions.length; r++) {
        const region = state.parallel.regions[r];
        const initialChild = region.states.find(s => s.isInitial) || region.states[0];
        lines.push(`        ${region.name}: {`);
        lines.push(`          initial: '${initialChild.name}',`);
        lines.push(`          states: {`);
        for (let j = 0; j < region.states.length; j++) {
          const child = region.states[j];
          lines.push(`            ${child.name}: {`);
          if (child.description) {
            lines.push(`              description: '${escapeString(child.description)}',`);
          }
          if (child.isFinal) {
            lines.push(`              type: 'final',`);
          }
          if (child.onEntry) {
            lines.push(`              entry: '${child.onEntry}',`);
          }
          if (child.onExit) {
            lines.push(`              exit: '${child.onExit}',`);
          }
          lines.push(`            }${j < region.states.length - 1 ? ',' : ''}`);
        }
        lines.push(`          },`);
        lines.push(`        }${r < state.parallel.regions.length - 1 ? ',' : ''}`);
      }
      lines.push(`      },`);
      if (state.onDone) {
        lines.push(`      onDone: { target: '${state.onDone}' },`);
      }
      lines.push(`    }${i < machine.states.length - 1 ? ',' : ''}`);
      continue;
    }

    // Leaf state configuration
    if (state.isFinal) {
      lines.push(`      type: 'final',`);
    }
    if (state.onEntry) {
      lines.push(`      entry: '${state.onEntry}',`);
    }
    if (state.onExit) {
      lines.push(`      exit: '${state.onExit}',`);
    }

    // Handle machine invocation
    if (state.invoke) {
      lines.push(`      invoke: {`);
      lines.push(`        src: '__machine__:${state.invoke.machine}',`);
      if (state.invoke.input) {
        // Build input mapping expression
        const inputPairs: string[] = [];
        for (const [key, value] of Object.entries(state.invoke.input)) {
          const fieldName = value.replace(/^ctx\./, '');
          inputPairs.push(`${key}: context.${fieldName}`);
        }
        lines.push(`        input: ({ context }) => ({ ${inputPairs.join(', ')} }),`);
      }
      if (state.invoke.onDone) {
        lines.push(`        onDone: { target: '${state.invoke.onDone}' },`);
      }
      if (state.invoke.onError) {
        lines.push(`        onError: { target: '${state.invoke.onError}' },`);
      }
      lines.push(`      },`);
    }

    // Collect transitions for this state
    const stateTransitions = machine.transitions.filter(t => t.source === state.name);

    if (stateTransitions.length > 0) {
      lines.push(`      on: {`);
      const eventGroups = groupByEvent(stateTransitions);
      const eventEntries = Object.entries(eventGroups);
      for (let ei = 0; ei < eventEntries.length; ei++) {
        const [eventName, trans] = eventEntries[ei];
        const isArrayFormat = trans.length > 1 || trans.some(t => t.guard);

        if (isArrayFormat) {
          // Multiple transitions or guarded transitions - use array format
          lines.push(`        ${eventName}: [`);
          for (const t of trans) {
            lines.push(`          {`);
            const target = t.target;
            lines.push(`            target: '${target}',`);
            if (t.guard) {
              const guardName = t.guard.negated ? `!${t.guard.name}` : t.guard.name;
              lines.push(`            guard: { type: '${guardName}' },`);
            }
            if (t.action) {
              lines.push(`            actions: '${t.action}',`);
            }
            lines.push(`          },`);
          }
          lines.push(`        ],`);
        } else {
          // Single unguarded transition - use object format
          const t = trans[0];
          lines.push(`        ${eventName}: {`);
          lines.push(`          target: '${t.target}',`);
          if (t.action) {
            lines.push(`          actions: '${t.action}',`);
          }
          lines.push(`        },`);
        }
      }
      lines.push(`      },`);
    }

    lines.push(`    }${i < machine.states.length - 1 ? ',' : ''}`);
  }

  lines.push(`  },`);

  // Emit guards section if any guards are defined
  if (machine.guards.length > 0) {
    lines.push(`}, {`);
    lines.push(`  guards: {`);
    for (const guard of machine.guards) {
      lines.push(`    '${guard.name}': ({ context }) => {`);
      lines.push(`      // TODO: implement guard logic for: ${guard.name}`);
      lines.push(`      return true;`);
      lines.push(`    },`);
    }
    lines.push(`  },`);
  }

  lines.push(`});`);

  return lines.join('\n');
}

function typeToTs(field: { type: { kind: string; name?: string; elementType?: string; innerType?: string; keyType?: string; valueType?: string } }): string {
  const t = field.type;
  switch (t.kind) {
    case 'string': return 'string';
    case 'int': return 'number';
    case 'decimal': return 'number';
    case 'bool': return 'boolean';
    case 'array': return `${t.elementType}[]`;
    case 'optional': return `${t.innerType} | null`;
    case 'map': return `Record<${t.keyType || 'string'}, ${t.valueType || 'any'}>`;
    case 'custom': return t.name || 'any';
    default: return 'any';
  }
}

function getDefaultForType(field: { type: { kind: string } }): string {
  switch (field.type.kind) {
    case 'string': return "''";
    case 'int':
    case 'decimal': return '0';
    case 'bool': return 'false';
    case 'array': return '[]';
    case 'map': return '{}';
    case 'optional': return 'null';
    default: return 'undefined';
  }
}

function getInitialState(machine: MachineDef): string {
  // Find top-level initial state (not nested)
  const initial = machine.states.find(s => s.isInitial);
  if (initial) {
    // If initial is compound, return its initial child
    if (initial.contains && initial.contains.length > 0) {
      const initialChild = initial.contains.find(s => s.isInitial) || initial.contains[0];
      return initial.name;  // XState will enter the compound state and use its initial
    }
    return initial.name;
  }
  return machine.states[0]?.name || 'unknown';
}

function groupByEvent(transitions: Transition[]): Record<string, Transition[]> {
  const groups: Record<string, Transition[]> = {};
  for (const t of transitions) {
    if (!groups[t.event]) groups[t.event] = [];
    groups[t.event].push(t);
  }
  return groups;
}

function escapeString(s: string): string {
  return s.replace(/'/g, "\\'");
}
