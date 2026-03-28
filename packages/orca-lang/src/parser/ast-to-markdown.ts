// AST to Markdown converter for Orca
// Converts MachineDef AST to .orca.md format

import {
  MachineDef, ContextField, StateDef, Transition,
  GuardDef, GuardExpression, ActionSignature, Property,
  Type, ValueRef, ParallelDef, EffectDef,
} from './ast.js';

function typeToString(type: Type): string {
  switch (type.kind) {
    case 'string': return 'string';
    case 'int': return 'int';
    case 'decimal': return 'decimal';
    case 'bool': return 'bool';
    case 'array': return `${type.elementType}[]`;
    case 'map': return `map<${type.keyType}, ${type.valueType}>`;
    case 'optional': return `${type.innerType}?`;
    case 'custom': return type.name;
  }
}

function guardExpressionToString(expr: GuardExpression): string {
  switch (expr.kind) {
    case 'true': return 'true';
    case 'false': return 'false';
    case 'not': {
      const inner = guardExpressionToString(expr.expr);
      // Add parens for clarity if inner is a compound expression
      if (expr.expr.kind === 'and' || expr.expr.kind === 'or') return `not (${inner})`;
      return `not ${inner}`;
    }
    case 'and': {
      const left = guardExpressionToString(expr.left);
      const right = guardExpressionToString(expr.right);
      const wrapLeft = expr.left.kind === 'or' ? `(${left})` : left;
      const wrapRight = expr.right.kind === 'or' ? `(${right})` : right;
      return `${wrapLeft} and ${wrapRight}`;
    }
    case 'or': return `${guardExpressionToString(expr.left)} or ${guardExpressionToString(expr.right)}`;
    case 'compare': {
      const opStr = { eq: '==', ne: '!=', lt: '<', gt: '>', le: '<=', ge: '>=' }[expr.op];
      return `${expr.left.path.join('.')} ${opStr} ${valueToString(expr.right)}`;
    }
    case 'nullcheck': return expr.expr.path.join('.');
  }
}

function valueToString(val: ValueRef): string {
  if (val.type === 'null') return 'null';
  if (val.type === 'string') return `"${val.value}"`;
  if (val.type === 'boolean') return String(val.value);
  return String(val.value);
}

function actionSignatureToString(action: ActionSignature): string {
  const params = action.parameters.join(', ');
  let sig = `(${params}) -> ${action.returnType}`;
  if (action.hasEffect && action.effectType) sig += ` + Effect<${action.effectType}>`;
  return sig;
}

function padColumn(rows: string[][], colIdx: number): void {
  const maxLen = Math.max(...rows.map(r => (r[colIdx] || '').length));
  for (const row of rows) {
    row[colIdx] = (row[colIdx] || '').padEnd(maxLen);
  }
}

function formatTable(headers: string[], rows: string[][]): string[] {
  const allRows = [headers, ...rows];
  for (let c = 0; c < headers.length; c++) padColumn(allRows, c);

  const lines: string[] = [];
  lines.push('| ' + allRows[0].join(' | ') + ' |');
  lines.push('|' + allRows[0].map(h => '-'.repeat(h.length + 2)).join('|') + '|');
  for (let r = 1; r < allRows.length; r++) {
    lines.push('| ' + allRows[r].join(' | ') + ' |');
  }
  return lines;
}

function emitStates(states: StateDef[], level: number): string[] {
  const lines: string[] = [];
  for (const state of states) {
    const prefix = '#'.repeat(level);
    const annotations: string[] = [];
    if (state.isInitial) annotations.push('initial');
    if (state.isFinal) annotations.push('final');
    if (state.parallel) {
      annotations.push('parallel');
      if (state.parallel.sync) annotations.push(`sync: ${state.parallel.sync}`);
    }

    let heading = `${prefix} state ${state.name}`;
    if (annotations.length > 0) heading += ` [${annotations.join(', ')}]`;
    lines.push(heading);

    if (state.description) lines.push(`> ${state.description}`);

    if (state.onEntry) lines.push(`- on_entry: ${state.onEntry}`);
    if (state.onExit) lines.push(`- on_exit: ${state.onExit}`);
    if (state.timeout) lines.push(`- timeout: ${state.timeout.duration} -> ${state.timeout.target}`);
    if (state.ignoredEvents?.length) lines.push(`- ignore: ${state.ignoredEvents.join(', ')}`);
    if (state.onDone) lines.push(`- on_done: -> ${state.onDone}`);

    if (state.parallel) {
      for (const region of state.parallel.regions) {
        lines.push('');
        lines.push(`${'#'.repeat(level + 1)} region ${region.name}`);
        lines.push('');
        lines.push(...emitStates(region.states, level + 2));
      }
    } else if (state.contains?.length) {
      lines.push('');
      lines.push(...emitStates(state.contains, level + 1));
    }

    lines.push('');
  }
  return lines;
}

function emitProperties(properties: Property[]): string[] {
  return properties.map(prop => {
    switch (prop.kind) {
      case 'reachable':
      case 'unreachable':
        return `- ${prop.kind}: ${prop.to} from ${prop.from}`;
      case 'passes_through':
        return `- passes_through: ${prop.through} for ${prop.from} -> ${prop.to}`;
      case 'live':
        return '- live';
      case 'responds':
        return `- responds: ${prop.to} from ${prop.from} within ${prop.within}`;
      case 'invariant': {
        const expr = guardExpressionToString(prop.expression);
        const inState = prop.inState ? ` in ${prop.inState}` : '';
        return `- invariant: \`${expr}\`${inState}`;
      }
    }
  });
}

export function machineToMarkdown(machine: MachineDef): string {
  const lines: string[] = [];

  lines.push(`# machine ${machine.name}`);
  lines.push('');

  // Context
  if (machine.context.length > 0) {
    lines.push('## context');
    lines.push('');
    const rows = machine.context.map(f => [f.name, typeToString(f.type), f.defaultValue || '']);
    lines.push(...formatTable(['Field', 'Type', 'Default'], rows));
    lines.push('');
  }

  // Events
  if (machine.events.length > 0) {
    lines.push('## events');
    lines.push('');
    for (const e of machine.events) lines.push(`- ${e.name}`);
    lines.push('');
  }

  // States
  lines.push(...emitStates(machine.states, 2));

  // Transitions
  if (machine.transitions.length > 0) {
    lines.push('## transitions');
    lines.push('');
    const rows = machine.transitions.map(t => {
      let guard = '';
      if (t.guard) guard = t.guard.negated ? `!${t.guard.name}` : t.guard.name;
      return [t.source, t.event, guard, t.target, t.action || ''];
    });
    lines.push(...formatTable(['Source', 'Event', 'Guard', 'Target', 'Action'], rows));
    lines.push('');
  }

  // Guards
  if (machine.guards.length > 0) {
    lines.push('## guards');
    lines.push('');
    const rows = machine.guards.map(g => [g.name, `\`${guardExpressionToString(g.expression)}\``]);
    lines.push(...formatTable(['Name', 'Expression'], rows));
    lines.push('');
  }

  // Actions
  if (machine.actions.length > 0) {
    lines.push('## actions');
    lines.push('');
    const rows = machine.actions.map(a => [a.name, `\`${actionSignatureToString(a)}\``]);
    lines.push(...formatTable(['Name', 'Signature'], rows));
    lines.push('');
  }

  // Effects
  if (machine.effects && machine.effects.length > 0) {
    lines.push('## effects');
    lines.push('');
    const rows = machine.effects.map(e => [e.name, e.input, e.output]);
    lines.push(...formatTable(['Name', 'Input', 'Output'], rows));
    lines.push('');
  }

  // Properties
  if (machine.properties?.length) {
    lines.push('## properties');
    lines.push('');
    lines.push(...emitProperties(machine.properties));
    lines.push('');
  }

  return lines.join('\n');
}
