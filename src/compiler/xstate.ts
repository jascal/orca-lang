import { MachineDef, Transition, ActionSignature, StateDef } from '../parser/ast.js';
import { createMachine, assign, fromCallback } from 'xstate';

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
      // Find which state uses this action
      for (const state of machine.states) {
        if (state.onEntry === action.name || state.onExit === action.name) {
          effectful.push({ name: action.name, effectType: action.effectType, state: state.name });
        }
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
    states[state.name] = buildStateConfig(state, machine);
  }

  return states;
}

function buildStateConfig(state: StateDef, machine: MachineDef): any {
  const config: any = {};

  if (state.description) {
    config.description = state.description;
  }
  if (state.isInitial) {
    config.type = 'initial';
  }
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

  // Handle transitions
  const stateTransitions = machine.transitions.filter(t => t.source === state.name);
  if (stateTransitions.length > 0) {
    config.on = buildTransitions(stateTransitions, machine);
  }

  // Handle timeout
  if (state.timeout) {
    config.after = {
      [state.timeout.duration]: { target: state.timeout.target },
    };
  }

  return config;
}

function buildEffectInvoke(actionName: string, action: ActionSignature, machine: MachineDef): any {
  // Find the state that has this action as entry or exit
  const stateName = machine.states.find(s => s.onEntry === actionName || s.onExit === actionName)?.name;
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

  // Return the invoke config directly, not wrapped in another object.
  return {
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
      target: 'error',
      actions: assign({
        _effectError: ({ event }: any) => event.error?.message,
      }),
    },
  };
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
    if (state.isInitial) {
      lines.push(`      type: 'initial',`);
    }
    if (state.isFinal) {
      lines.push(`      type: 'final',`);
    }
    if (state.onEntry) {
      lines.push(`      entry: '${state.onEntry}',`);
    }
    if (state.onExit) {
      lines.push(`      exit: '${state.onExit}',`);
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
              lines.push(`            guard: '${guardName}',`);
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
  const initial = machine.states.find(s => s.isInitial);
  return initial?.name || machine.states[0]?.name || 'unknown';
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
