import { MachineDef } from '../parser/ast.js';

export function compileToMermaid(machine: MachineDef): string {
  const lines: string[] = [];

  lines.push(`stateDiagram-v2`);
  lines.push(`  direction LR`);
  lines.push(``);

  // Add style for initial state
  lines.push(`  [*] --> ${getInitialStateName(machine)}`);

  // Add states with descriptions
  for (const state of machine.states) {
    if (state.isFinal) {
      lines.push(`  ${state.name} --> [*] :_final`);
    }
  }

  lines.push(``);

  // Add transitions
  for (const t of machine.transitions) {
    let label = t.event;
    if (t.guard) {
      label += ` [${t.guard.negated ? '!' : ''}${t.guard.name}]`;
    }
    if (t.action && t.action !== '_') {
      label += ` / ${t.action}`;
    }
    lines.push(`  ${t.source} --> ${t.target} : ${label}`);
  }

  return lines.join('\n');
}

function getInitialStateName(machine: MachineDef): string {
  const initial = machine.states.find(s => s.isInitial);
  return initial?.name || machine.states[0]?.name || 'unknown';
}
