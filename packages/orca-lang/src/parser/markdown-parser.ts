// Markdown Parser for Orca (.orca.md files)
// Two-phase parser: structural markdown → semantic AST
// Produces identical MachineDef AST as the DSL parser

import {
  ParseResult, MachineDef, OrcaFile, ContextField, EventDef, StateDef,
  Transition, GuardDef, GuardExpression, ActionSignature, EffectDef,
  ParallelDef, RegionDef, SyncStrategy, Property, Type,
  GuardRef, VariableRef, ValueRef, ComparisonOp,
  ReachabilityProperty, PassesThroughProperty, RespondsProperty,
  InvariantProperty, InvokeDef,
} from './ast.js';
import { DecisionTableDef } from './dt-ast.js';
import { parseDecisionTable } from './dt-parser.js';

// ============================================================
// Phase 1: Structural Markdown Parsing
// ============================================================

interface MdHeading { kind: 'heading'; level: number; text: string; line: number }
interface MdTable { kind: 'table'; headers: string[]; rows: string[][]; line: number }
interface MdBulletList { kind: 'bullets'; items: string[]; line: number }
interface MdBlockquote { kind: 'blockquote'; text: string; line: number }
interface MdParagraph { kind: 'paragraph'; text: string; line: number }
interface MdSeparator { kind: 'separator'; line: number }

type MdElement = MdHeading | MdTable | MdBulletList | MdBlockquote | MdParagraph | MdSeparator;

function parseMarkdownStructure(source: string): MdElement[] {
  const lines = source.split('\n');
  const elements: MdElement[] = [];
  let i = 0;

  while (i < lines.length) {
    const trimmed = lines[i].trim();

    if (trimmed === '') { i++; continue; }

    // Skip fenced code blocks
    if (trimmed.startsWith('```')) {
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) i++;
      if (i < lines.length) i++;
      continue;
    }

    // Horizontal rule separator (--- between machines)
    if (trimmed === '---') {
      elements.push({ kind: 'separator', line: i + 1 });
      i++;
      continue;
    }

    // Heading
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      elements.push({ kind: 'heading', level: headingMatch[1].length, text: headingMatch[2].trim(), line: i + 1 });
      i++;
      continue;
    }

    // Blockquote
    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      const startLine = i + 1;
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoteLines.push(lines[i].trim().replace(/^>\s*/, ''));
        i++;
      }
      elements.push({ kind: 'blockquote', text: quoteLines.join('\n'), line: startLine });
      continue;
    }

    // Table
    if (trimmed.startsWith('|')) {
      const tableLines: string[] = [];
      const startLine = i + 1;
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        tableLines.push(lines[i].trim());
        i++;
      }
      if (tableLines.length >= 2) {
        const headers = parseTableRow(tableLines[0]);
        const isSeparator = /^\|[\s\-:|]+\|$/.test(tableLines[1]);
        const dataStart = isSeparator ? 2 : 1;
        const rows: string[][] = [];
        for (let j = dataStart; j < tableLines.length; j++) {
          rows.push(parseTableRow(tableLines[j]));
        }
        elements.push({ kind: 'table', headers, rows, line: startLine });
      }
      continue;
    }

    // Bullet list
    if (trimmed.startsWith('- ')) {
      const items: string[] = [];
      const startLine = i + 1;
      while (i < lines.length && lines[i].trim().startsWith('- ')) {
        items.push(lines[i].trim().substring(2).trim());
        i++;
      }
      elements.push({ kind: 'bullets', items, line: startLine });
      continue;
    }

    // Paragraph (any other text)
    const paraLines: string[] = [];
    const startLine = i + 1;
    while (i < lines.length && lines[i].trim() !== '' &&
           !lines[i].trim().startsWith('#') &&
           !lines[i].trim().startsWith('|') &&
           !lines[i].trim().startsWith('>') &&
           !lines[i].trim().startsWith('- ') &&
           !lines[i].trim().startsWith('```')) {
      paraLines.push(lines[i].trim());
      i++;
    }
    if (paraLines.length > 0) {
      elements.push({ kind: 'paragraph', text: paraLines.join('\n'), line: startLine });
    }
  }

  return elements;
}

function parseTableRow(line: string): string[] {
  const cells = line.split('|').map(c => c.trim());
  if (cells.length > 0 && cells[0] === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

// ============================================================
// Micro-Parsers
// ============================================================

function stripBackticks(text: string): string {
  if (text.startsWith('`') && text.endsWith('`')) return text.slice(1, -1);
  return text;
}

function findColumnIndex(headers: string[], name: string): number {
  return headers.findIndex(h => h.toLowerCase() === name.toLowerCase());
}

// --- Type Micro-Parser ---

function parseTypeString(text: string): Type {
  text = text.trim();
  if (text.endsWith('?')) {
    return { kind: 'optional', innerType: text.slice(0, -1) };
  }
  if (text.endsWith('[]')) {
    return { kind: 'array', elementType: text.slice(0, -2) };
  }
  const mapMatch = text.match(/^map<\s*(\w+)\s*,\s*(\w+)\s*>$/);
  if (mapMatch) {
    return { kind: 'map', keyType: mapMatch[1], valueType: mapMatch[2] };
  }
  switch (text) {
    case 'string': return { kind: 'string' };
    case 'int': return { kind: 'int' };
    case 'decimal': return { kind: 'decimal' };
    case 'bool': return { kind: 'bool' };
    default: return { kind: 'custom', name: text };
  }
}

// --- Guard Expression Micro-Parser ---

interface MicroToken {
  type: 'IDENT' | 'NUMBER' | 'STRING' | 'DOT' | 'LPAREN' | 'RPAREN' |
    'EQ' | 'NE' | 'LT' | 'GT' | 'LE' | 'GE' | 'NOT' | 'AND' | 'OR' | 'EOF';
  value: string;
}

function tokenizeExpression(text: string): MicroToken[] {
  const tokens: MicroToken[] = [];
  let i = 0;

  while (i < text.length) {
    if (/\s/.test(text[i])) { i++; continue; }

    // Two-char operators
    if (i + 1 < text.length) {
      const two = text.slice(i, i + 2);
      if (two === '==') { tokens.push({ type: 'EQ', value: '==' }); i += 2; continue; }
      if (two === '!=') { tokens.push({ type: 'NE', value: '!=' }); i += 2; continue; }
      if (two === '<=') { tokens.push({ type: 'LE', value: '<=' }); i += 2; continue; }
      if (two === '>=') { tokens.push({ type: 'GE', value: '>=' }); i += 2; continue; }
      if (two === '&&') { tokens.push({ type: 'AND', value: '&&' }); i += 2; continue; }
      if (two === '||') { tokens.push({ type: 'OR', value: '||' }); i += 2; continue; }
    }

    const ch = text[i];
    if (ch === '<') { tokens.push({ type: 'LT', value: '<' }); i++; continue; }
    if (ch === '>') { tokens.push({ type: 'GT', value: '>' }); i++; continue; }
    if (ch === '!') { tokens.push({ type: 'NOT', value: '!' }); i++; continue; }
    if (ch === '=') { tokens.push({ type: 'EQ', value: '=' }); i++; continue; }
    if (ch === '.') { tokens.push({ type: 'DOT', value: '.' }); i++; continue; }
    if (ch === '(') { tokens.push({ type: 'LPAREN', value: '(' }); i++; continue; }
    if (ch === ')') { tokens.push({ type: 'RPAREN', value: ')' }); i++; continue; }

    if (/[0-9]/.test(ch)) {
      let num = '';
      while (i < text.length && /[0-9.]/.test(text[i])) num += text[i++];
      tokens.push({ type: 'NUMBER', value: num });
      continue;
    }

    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      let str = '';
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\') i++;
        str += text[i++];
      }
      if (i < text.length) i++;
      tokens.push({ type: 'STRING', value: str });
      continue;
    }

    if (/[a-zA-Z_]/.test(ch)) {
      let ident = '';
      while (i < text.length && /[a-zA-Z0-9_]/.test(text[i])) ident += text[i++];
      tokens.push({ type: 'IDENT', value: ident });
      continue;
    }

    i++; // skip unknown
  }

  tokens.push({ type: 'EOF', value: '' });
  return tokens;
}

class ExpressionParser {
  private tokens: MicroToken[];
  private pos = 0;

  constructor(tokens: MicroToken[]) { this.tokens = tokens; }

  private peek(): MicroToken { return this.tokens[this.pos] || { type: 'EOF', value: '' }; }
  private advance(): MicroToken { return this.tokens[this.pos++] || { type: 'EOF', value: '' }; }

  private match(type: string): boolean {
    if (this.peek().type === type) { this.advance(); return true; }
    return false;
  }

  private expect(type: string): MicroToken {
    const tok = this.advance();
    if (tok.type !== type) throw new Error(`Expected ${type}, got ${tok.type} "${tok.value}"`);
    return tok;
  }

  parse(): GuardExpression { return this.parseOr(); }

  private parseOr(): GuardExpression {
    let left = this.parseAnd();
    while (this.peek().type === 'OR' || (this.peek().type === 'IDENT' && this.peek().value === 'or')) {
      this.advance();
      left = { kind: 'or', left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): GuardExpression {
    let left = this.parseNot();
    while (this.peek().type === 'AND' || (this.peek().type === 'IDENT' && this.peek().value === 'and')) {
      this.advance();
      left = { kind: 'and', left, right: this.parseNot() };
    }
    return left;
  }

  private parseNot(): GuardExpression {
    if (this.peek().type === 'NOT' || (this.peek().type === 'IDENT' && this.peek().value === 'not')) {
      this.advance();
      return { kind: 'not', expr: this.parsePrimary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): GuardExpression {
    if (this.match('LPAREN')) {
      const expr = this.parseOr();
      this.expect('RPAREN');
      return expr;
    }

    if (this.peek().type === 'IDENT' && this.peek().value === 'true') {
      this.advance(); return { kind: 'true' };
    }
    if (this.peek().type === 'IDENT' && this.peek().value === 'false') {
      this.advance(); return { kind: 'false' };
    }

    const varPath = this.parseVariablePath();

    const op = this.peek().type;
    if (['EQ', 'NE', 'LT', 'GT', 'LE', 'GE'].includes(op)) {
      const opTok = this.advance();
      const cmpOp = ({ EQ: 'eq', NE: 'ne', LT: 'lt', GT: 'gt', LE: 'le', GE: 'ge' } as Record<string, ComparisonOp>)[opTok.type]!;
      return { kind: 'compare', op: cmpOp, left: varPath, right: this.parseValue() };
    }

    return { kind: 'nullcheck', expr: varPath, isNull: false };
  }

  private parseVariablePath(): VariableRef {
    const parts: string[] = [this.expect('IDENT').value];
    while (this.peek().type === 'DOT') { this.advance(); parts.push(this.expect('IDENT').value); }
    return { kind: 'variable', path: parts };
  }

  private parseValue(): ValueRef {
    const tok = this.peek();
    if (tok.type === 'NUMBER') { this.advance(); return { kind: 'value', type: 'number', value: parseFloat(tok.value) }; }
    if (tok.type === 'STRING') { this.advance(); return { kind: 'value', type: 'string', value: tok.value }; }
    if (tok.type === 'IDENT') {
      this.advance();
      if (tok.value === 'null') return { kind: 'value', type: 'null', value: null };
      if (tok.value === 'true') return { kind: 'value', type: 'boolean', value: true };
      if (tok.value === 'false') return { kind: 'value', type: 'boolean', value: false };
      return { kind: 'value', type: 'null', value: tok.value };
    }
    return { kind: 'value', type: 'null', value: null };
  }
}

function parseGuardExpressionFromString(text: string): GuardExpression {
  return new ExpressionParser(tokenizeExpression(text)).parse();
}

// --- Action Signature Micro-Parser ---

function parseActionSignatureFromString(name: string, text: string): ActionSignature {
  text = text.trim();
  const parenStart = text.indexOf('(');
  const parenEnd = text.indexOf(')');
  const paramsStr = text.slice(parenStart + 1, parenEnd).trim();

  const parameters: string[] = [];
  if (paramsStr) {
    for (const param of paramsStr.split(',')) {
      const paramName = param.trim().split(':')[0].trim();
      if (paramName) parameters.push(paramName);
    }
  }

  const afterParen = text.slice(parenEnd + 1).trim();
  const arrowIdx = afterParen.indexOf('->');
  const returnPart = afterParen.slice(arrowIdx + 2).trim();

  let returnType = 'Context';
  let hasEffect = false;
  let effectType: string | undefined;

  const plusIdx = returnPart.indexOf('+');
  if (plusIdx !== -1) {
    returnType = returnPart.slice(0, plusIdx).trim();
    const effectMatch = returnPart.slice(plusIdx + 1).trim().match(/Effect<(\w+)>/);
    if (effectMatch) { hasEffect = true; effectType = effectMatch[1]; }
  } else {
    returnType = returnPart;
  }

  return { name, parameters, returnType, hasEffect, effectType };
}

// ============================================================
// Phase 2: Semantic Parsing
// ============================================================

interface StateEntry {
  type: 'state' | 'region';
  level: number;
  name: string;
  isInitial: boolean;
  isFinal: boolean;
  isParallel: boolean;
  syncStrategy?: SyncStrategy;
  description?: string;
  onEntry?: string;
  onExit?: string;
  onDone?: string;
  timeout?: { duration: string; target: string };
  invoke?: InvokeDef;
  _pendingOnError?: string;  // temp: on_error parsed before invoke
  ignoredEvents?: string[];
  ignoredAll?: boolean;
  line: number;
}

function parseAnnotations(text: string): { isInitial: boolean; isFinal: boolean; isParallel: boolean; syncStrategy?: SyncStrategy } {
  let isInitial = false, isFinal = false, isParallel = false;
  let syncStrategy: SyncStrategy | undefined;

  const bracketMatch = text.match(/\[(.+)\]/);
  if (bracketMatch) {
    for (const part of bracketMatch[1].split(',').map(p => p.trim())) {
      if (part === 'initial') isInitial = true;
      else if (part === 'final') isFinal = true;
      else if (part === 'parallel') isParallel = true;
      else if (part.startsWith('sync:')) {
        const v = part.slice(5).trim();
        if (v === 'all-final' || v === 'all_final') syncStrategy = 'all-final';
        else if (v === 'any-final' || v === 'any_final') syncStrategy = 'any-final';
        else if (v === 'custom') syncStrategy = 'custom';
      }
    }
  }
  return { isInitial, isFinal, isParallel, syncStrategy };
}

function parseStateBullet(entry: StateEntry, text: string): void {
  if (text.startsWith('on_entry:')) {
    let val = text.slice(9).trim();
    if (val.startsWith('->')) val = val.slice(2).trim();
    entry.onEntry = val;
  } else if (text.startsWith('on_exit:')) {
    let val = text.slice(8).trim();
    if (val.startsWith('->')) val = val.slice(2).trim();
    entry.onExit = val;
  } else if (text.startsWith('timeout:')) {
    const rest = text.slice(8).trim();
    const arrowIdx = rest.indexOf('->');
    if (arrowIdx !== -1) {
      entry.timeout = { duration: rest.slice(0, arrowIdx).trim(), target: rest.slice(arrowIdx + 2).trim() };
    }
  } else if (text.startsWith('ignore:')) {
    const val = text.slice(7).trim();
    if (val === '*') {
      entry.ignoredAll = true;
    } else {
      const names = val.split(',').map(e => e.trim()).filter(Boolean);
      if (!entry.ignoredEvents) entry.ignoredEvents = [];
      entry.ignoredEvents.push(...names);
    }
  } else if (text.startsWith('on_done:')) {
    let val = text.slice(8).trim();
    if (val.startsWith('->')) val = val.slice(2).trim();
    if (entry.invoke) {
      entry.invoke.onDone = val;
    }
    // Also set entry.onDone for non-invoke states (like parallel sync on_done)
    entry.onDone = val;
  } else if (text.startsWith('on_error:')) {
    let val = text.slice(9).trim();
    if (val.startsWith('->')) val = val.slice(2).trim();
    if (entry.invoke) {
      entry.invoke.onError = val;
    } else {
      entry._pendingOnError = val;
    }
  } else if (text.startsWith('invoke:')) {
    const rest = text.slice(7).trim();
    // Format: "MachineName" or "MachineName input: { field: ctx.field }"
    const inputMatch = rest.match(/^(\w+)\s+input:\s*\{(.+)\}$/);
    const pendingOnError = entry._pendingOnError;
    delete entry._pendingOnError;
    if (inputMatch) {
      const machineName = inputMatch[1];
      const inputStr = inputMatch[2];
      const input: Record<string, string> = {};
      // Parse { field: ctx.field } into { field: "ctx.field" }
      const pairs = inputStr.split(',').map(p => p.trim());
      for (const pair of pairs) {
        const colonIdx = pair.indexOf(':');
        if (colonIdx !== -1) {
          const key = pair.slice(0, colonIdx).trim();
          const val = pair.slice(colonIdx + 1).trim();
          input[key] = val;
        }
      }
      entry.invoke = { machine: machineName, input, onError: pendingOnError };
    } else {
      entry.invoke = { machine: rest, onError: pendingOnError };
    }
  }
}

function parsePropertyFromBullet(text: string): Property {
  text = text.trim();

  if (text === 'live') return { kind: 'live' };

  if (text.startsWith('reachable:') || text.startsWith('unreachable:')) {
    const kind = text.startsWith('reachable:') ? 'reachable' as const : 'unreachable' as const;
    const rest = text.slice(text.indexOf(':') + 1).trim();
    const parts = rest.split(/\s+from\s+/);
    // Match DSL parser property order: kind, from, to
    return { kind, from: parts[1].trim(), to: parts[0].trim() };
  }

  if (text.startsWith('passes_through:')) {
    const rest = text.slice(15).trim();
    const forParts = rest.split(/\s+for\s+/);
    const through = forParts[0].trim();
    const arrowParts = forParts[1].split(/\s*->\s*/);
    // Match DSL parser property order: from, to, through
    return { kind: 'passes_through', from: arrowParts[0].trim(), to: arrowParts[1].trim(), through };
  }

  if (text.startsWith('responds:')) {
    const rest = text.slice(9).trim();
    const parts = rest.split(/\s+from\s+/);
    const to = parts[0].trim();
    const withinParts = parts[1].split(/\s+within\s+/);
    const from = withinParts[0].trim();
    const within = parseInt(withinParts[1].trim(), 10);
    // Match DSL parser property order: kind, from, to, within
    return { kind: 'responds', from, to, within } as RespondsProperty;
  }

  if (text.startsWith('invariant:')) {
    const rest = text.slice(10).trim();
    const backtickMatch = rest.match(/`([^`]+)`(\s+in\s+(\S+))?/);
    if (backtickMatch) {
      const prop: InvariantProperty = { kind: 'invariant', expression: parseGuardExpressionFromString(backtickMatch[1]) };
      if (backtickMatch[3]) prop.inState = backtickMatch[3];
      return prop;
    }
  }

  throw new Error(`Unknown property: ${text}`);
}

// --- Context / Events / Transitions / Guards / Actions table parsers ---

function parseContextTable(table: MdTable): ContextField[] {
  const fi = findColumnIndex(table.headers, 'field');
  const ti = findColumnIndex(table.headers, 'type');
  const di = findColumnIndex(table.headers, 'default');

  return table.rows.map(row => {
    const field: ContextField = {
      name: row[fi]?.trim() || '',
      type: parseTypeString(row[ti]?.trim() || 'string'),
    };
    const def = di >= 0 ? row[di]?.trim() : '';
    if (def) field.defaultValue = def;
    return field;
  });
}

function parseEventsList(list: MdBulletList): EventDef[] {
  const events: EventDef[] = [];
  for (const item of list.items) {
    for (const name of item.split(',').map(n => n.trim()).filter(Boolean)) {
      events.push({ name });
    }
  }
  return events;
}

function parseTransitionsTable(table: MdTable): Transition[] {
  const si = findColumnIndex(table.headers, 'source');
  const ei = findColumnIndex(table.headers, 'event');
  const gi = findColumnIndex(table.headers, 'guard');
  const ti = findColumnIndex(table.headers, 'target');
  const ai = findColumnIndex(table.headers, 'action');

  return table.rows.map(row => {
    const source = row[si]?.trim() || '';
    const event = row[ei]?.trim() || '';
    const guardStr = row[gi]?.trim() || '';
    const target = row[ti]?.trim() || '';
    const actionStr = row[ai]?.trim() || '';

    // Build transition with same property order as DSL parser
    const t: Transition = { source, event, target };
    if (guardStr) {
      // Insert guard before target to match DSL property order
      const guard: GuardRef = guardStr.startsWith('!')
        ? { name: guardStr.slice(1), negated: true }
        : { name: guardStr, negated: false };
      return { source, event, guard, target, ...(actionStr && actionStr !== '_' ? { action: actionStr } : {}) };
    }
    if (actionStr && actionStr !== '_') t.action = actionStr;
    return t;
  });
}

function parseGuardsTable(table: MdTable): GuardDef[] {
  const ni = findColumnIndex(table.headers, 'name');
  const ei = findColumnIndex(table.headers, 'expression');
  return table.rows.map(row => ({
    name: row[ni]?.trim() || '',
    expression: parseGuardExpressionFromString(stripBackticks(row[ei]?.trim() || '')),
  }));
}

function parseActionsTable(table: MdTable): ActionSignature[] {
  const ni = findColumnIndex(table.headers, 'name');
  const si = findColumnIndex(table.headers, 'signature');
  const ei = findColumnIndex(table.headers, 'effect');  // optional separate column
  return table.rows.map(row => {
    const action = parseActionSignatureFromString(row[ni]?.trim() || '', stripBackticks(row[si]?.trim() || ''));
    // If a separate Effect column exists and signature didn't already embed an effect
    if (ei >= 0 && !action.hasEffect) {
      const effectName = row[ei]?.trim() || '';
      if (effectName) {
        action.hasEffect = true;
        action.effectType = effectName;
      }
    }
    return action;
  });
}

// --- State Hierarchy Builder ---

function buildStatesAtLevel(
  entries: StateEntry[], startIdx: number, level: number, parentName?: string
): { states: StateDef[]; nextIdx: number } {
  const states: StateDef[] = [];
  let i = startIdx;

  while (i < entries.length) {
    const entry = entries[i];
    if (entry.level < level) break;
    if (entry.type === 'region') break;
    if (entry.level > level) { i++; continue; }

    // Build state with same property order as DSL parser:
    // { name, isInitial, isFinal, parent?, description?, onEntry?, onExit?, ... }
    const state: StateDef = { name: entry.name, isInitial: entry.isInitial, isFinal: entry.isFinal };
    if (parentName) state.parent = parentName;
    if (entry.description) state.description = entry.description;
    if (entry.onEntry) state.onEntry = entry.onEntry;
    if (entry.onExit) state.onExit = entry.onExit;
    if (entry.onDone) state.onDone = entry.onDone;
    if (entry.timeout) state.timeout = entry.timeout;
    if (entry.ignoredEvents?.length) state.ignoredEvents = entry.ignoredEvents;
    if (entry.ignoredAll) state.ignoredAll = true;
    if (entry.invoke) state.invoke = entry.invoke;

    i++;

    if (entry.isParallel) {
      const result = buildParallelRegions(entries, i, level + 1, entry.name, entry.syncStrategy);
      state.parallel = result.parallelDef;
      i = result.nextIdx;
    } else if (i < entries.length && entries[i].level === level + 1 && entries[i].type === 'state') {
      const result = buildStatesAtLevel(entries, i, level + 1, entry.name);
      state.contains = result.states;
      i = result.nextIdx;
    }

    states.push(state);
  }

  return { states, nextIdx: i };
}

function buildParallelRegions(
  entries: StateEntry[], startIdx: number, regionLevel: number,
  parentName: string, syncStrategy?: SyncStrategy
): { parallelDef: ParallelDef; nextIdx: number } {
  const regions: RegionDef[] = [];
  let i = startIdx;

  while (i < entries.length && entries[i].level >= regionLevel) {
    if (entries[i].type !== 'region' || entries[i].level !== regionLevel) break;

    const regionName = entries[i].name;
    i++;

    const regionStates: StateDef[] = [];
    while (i < entries.length && entries[i].level > regionLevel) {
      if (entries[i].type === 'state' && entries[i].level === regionLevel + 1) {
        const e = entries[i];
        // Match DSL parser property order: name, isInitial, isFinal, parent, then body props
        const s: StateDef = {
          name: e.name, isInitial: e.isInitial, isFinal: e.isFinal,
          parent: `${parentName}.${regionName}`,
        };
        if (e.description) s.description = e.description;
        if (e.onEntry) s.onEntry = e.onEntry;
        if (e.onExit) s.onExit = e.onExit;
        if (e.onDone) s.onDone = e.onDone;
        if (e.timeout) s.timeout = e.timeout;
        if (e.ignoredEvents?.length) s.ignoredEvents = e.ignoredEvents;
        if (e.ignoredAll) s.ignoredAll = true;
        if (e.invoke) s.invoke = e.invoke;
        regionStates.push(s);
        i++;
      } else {
        break;
      }
    }

    regions.push({ name: regionName, states: regionStates });
  }

  return { parallelDef: { regions, sync: syncStrategy }, nextIdx: i };
}

// --- Main Semantic Parser ---

function parseMachineFromElements(elements: MdElement[]): MachineDef {
  let machineName = '';
  let context: ContextField[] = [];
  let events: EventDef[] = [];
  let transitions: Transition[] = [];
  let guards: GuardDef[] = [];
  let actions: ActionSignature[] = [];
  let effects: EffectDef[] | undefined;
  let properties: Property[] | undefined;
  const stateEntries: StateEntry[] = [];
  let currentStateEntry: StateEntry | null = null;

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];

    if (el.kind === 'heading') {
      // Machine heading
      if (el.level === 1 && el.text.startsWith('machine ')) {
        machineName = el.text.slice(8).trim();
        currentStateEntry = null;
        continue;
      }

      // Non-state section headings
      const sectionName = el.text.toLowerCase();
      if (['context', 'events', 'transitions', 'guards', 'actions', 'effects', 'properties'].includes(sectionName)) {
        currentStateEntry = null;

        // Skip past any intervening paragraphs/blockquotes (LLMs often add descriptions)
        let j = i + 1;
        while (j < elements.length && (elements[j].kind === 'paragraph' || elements[j].kind === 'blockquote')) j++;
        const nextEl = elements[j];

        if (sectionName === 'context' && nextEl?.kind === 'table') {
          context = parseContextTable(nextEl); i = j;
        } else if (sectionName === 'events' && nextEl?.kind === 'bullets') {
          events = parseEventsList(nextEl); i = j;
        } else if (sectionName === 'transitions' && nextEl?.kind === 'table') {
          transitions = parseTransitionsTable(nextEl); i = j;
        } else if (sectionName === 'guards' && nextEl?.kind === 'table') {
          guards = parseGuardsTable(nextEl); i = j;
        } else if (sectionName === 'actions' && nextEl?.kind === 'table') {
          actions = parseActionsTable(nextEl); i = j;
        } else if (sectionName === 'effects' && nextEl?.kind === 'table') {
          effects = parseEffectsTable(nextEl); i = j;
        } else if (sectionName === 'properties' && nextEl?.kind === 'bullets') {
          properties = parsePropertiesList(nextEl); i = j;
        }
        continue;
      }

      // State heading
      const stateMatch = el.text.match(/^state\s+(\w+)(.*)$/);
      if (stateMatch) {
        currentStateEntry = {
          type: 'state', level: el.level, name: stateMatch[1], line: el.line,
          ...parseAnnotations(stateMatch[2]?.trim() || ''),
        };
        stateEntries.push(currentStateEntry);
        continue;
      }

      // Region heading
      const regionMatch = el.text.match(/^region\s+(\w+)$/);
      if (regionMatch) {
        currentStateEntry = null;
        stateEntries.push({
          type: 'region', level: el.level, name: regionMatch[1], line: el.line,
          isInitial: false, isFinal: false, isParallel: false,
        });
        continue;
      }

      // Unknown heading — close current state
      currentStateEntry = null;
      continue;
    }

    // Content belonging to current state
    if (currentStateEntry) {
      if (el.kind === 'blockquote') {
        currentStateEntry.description = el.text;
      } else if (el.kind === 'bullets') {
        for (const item of el.items) parseStateBullet(currentStateEntry, item);
      }
    }
  }

  // Build state hierarchy from flat entries
  const baseLevel = stateEntries.length > 0 ? stateEntries[0].level : 2;
  const states = buildStatesAtLevel(stateEntries, 0, baseLevel).states;

  const machine: MachineDef = { name: machineName, context, events, states, transitions, guards, actions };
  if (effects !== undefined) machine.effects = effects;
  if (properties && properties.length > 0) machine.properties = properties;
  return machine;
}

function parseMarkdownSemantic(elements: MdElement[]): { machines: MachineDef[]; decisionTables: DecisionTableDef[] } {
  // Split elements by --- separators for multi-machine files
  const chunks: MdElement[][] = [];
  let currentChunk: MdElement[] = [];

  for (const el of elements) {
    if (el.kind === 'separator') {
      if (currentChunk.length > 0) {
        chunks.push(currentChunk);
        currentChunk = [];
      }
    } else {
      currentChunk.push(el);
    }
  }
  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  // Parse each chunk based on its H1 heading type
  const machines: MachineDef[] = [];
  const decisionTables: DecisionTableDef[] = [];

  for (const chunk of chunks) {
    // Find ALL H1 headings in the chunk to determine what it contains
    const headings = chunk.filter(el => el.kind === 'heading' && el.level === 1) as MdHeading[];

    // Check if chunk contains a decision_table (must be first H1 to be recognized as DT chunk)
    const firstHeading = headings[0];
    if (firstHeading?.text.startsWith('decision_table ')) {
      const { decisionTable } = parseDecisionTable(chunk);
      decisionTables.push(decisionTable);
    } else if (firstHeading?.text.startsWith('machine ')) {
      // First heading is machine - parse entire chunk as machine
      machines.push(parseMachineFromElements(chunk));
    } else {
      // First heading is not machine or decision_table - scan for machine heading
      const machineHeading = headings.find(h => h.text.startsWith('machine '));
      if (machineHeading) {
        machines.push(parseMachineFromElements(chunk));
      }
      // Skip chunks without a recognized machine or decision_table heading
    }
  }

  return { machines, decisionTables };
}

function parseEffectsTable(table: MdTable): EffectDef[] {
  const ni = findColumnIndex(table.headers, 'name');
  const ii = findColumnIndex(table.headers, 'input');
  const oi = findColumnIndex(table.headers, 'output');
  return table.rows.map(row => ({
    name: stripBackticks((ni >= 0 ? row[ni] : '') || '').trim(),
    input: ((ii >= 0 ? row[ii] : '') || '').trim(),
    output: ((oi >= 0 ? row[oi] : '') || '').trim(),
  })).filter(e => e.name !== '');
}

function parsePropertiesList(list: MdBulletList): Property[] {
  return list.items.map(parsePropertyFromBullet);
}

// ============================================================
// Public API
// ============================================================

export function parseMarkdown(source: string): ParseResult {
  const elements = parseMarkdownStructure(source);
  const { machines, decisionTables } = parseMarkdownSemantic(elements);
  return { file: { machines, decisionTables }, tokens: [] };
}

/**
 * Parse a single-machine markdown source. For multi-machine files, returns the first machine.
 * @deprecated Use parseMarkdown() and access result.file.machines[0] for explicit handling
 */
export function parseMachine(source: string): MachineDef {
  const { file } = parseMarkdown(source);
  return file.machines[0];
}
