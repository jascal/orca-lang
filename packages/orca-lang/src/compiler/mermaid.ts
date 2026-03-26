import { MachineDef, StateDef } from '../parser/ast.js';

export function compileToMermaid(machine: MachineDef): string {
  const lines: string[] = [];

  lines.push(`stateDiagram-v2`);
  lines.push(`  direction LR`);
  lines.push(``);

  // Add initial state transition
  lines.push(`  [*] --> ${getInitialStateName(machine)}`);

  // Add termination transitions for top-level final states
  for (const state of machine.states) {
    if (state.isFinal) {
      lines.push(`  ${state.name} --> [*]`);
    }
  }

  lines.push(``);

  // Render compound/parallel state bodies
  for (const state of machine.states) {
    renderStateBody(state, machine, lines, '  ');
  }

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

function renderStateBody(state: StateDef, machine: MachineDef, lines: string[], indent: string): void {
  // Hierarchical compound states
  if (state.contains && state.contains.length > 0) {
    lines.push(`${indent}state ${state.name} {`);
    const inner = indent + '  ';

    // Initial child transition
    const initialChild = state.contains.find(s => s.isInitial) || state.contains[0];
    lines.push(`${inner}[*] --> ${initialChild.name}`);

    // Final child transitions
    for (const child of state.contains) {
      if (child.isFinal) {
        lines.push(`${inner}${child.name} --> [*]`);
      }
    }

    // Recurse into children that are themselves compound/parallel
    for (const child of state.contains) {
      renderStateBody(child, machine, lines, inner);
    }

    lines.push(`${indent}}`);
  }

  // Parallel states
  if (state.parallel) {
    lines.push(`${indent}state ${state.name} {`);
    const inner = indent + '  ';

    for (let i = 0; i < state.parallel.regions.length; i++) {
      const region = state.parallel.regions[i];

      // Region separator between regions
      if (i > 0) {
        lines.push(`${inner}--`);
      }

      lines.push(`${inner}state ${region.name} {`);
      const regionInner = inner + '  ';

      // Initial child transition within region
      const initialChild = region.states.find(s => s.isInitial) || region.states[0];
      lines.push(`${regionInner}[*] --> ${initialChild.name}`);

      // Final child transitions within region
      for (const child of region.states) {
        if (child.isFinal) {
          lines.push(`${regionInner}${child.name} --> [*]`);
        }
      }

      // Recurse into children
      for (const child of region.states) {
        renderStateBody(child, machine, lines, regionInner);
      }

      lines.push(`${inner}}`);
    }

    lines.push(`${indent}}`);
  }
}

function getInitialStateName(machine: MachineDef): string {
  const initial = machine.states.find(s => s.isInitial);
  return initial?.name || machine.states[0]?.name || 'unknown';
}
