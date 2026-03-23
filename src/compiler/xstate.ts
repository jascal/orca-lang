import { MachineDef, Transition } from '../parser/ast.js';

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
            const target = t.guard ? `#${t.target}` : t.target;
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
