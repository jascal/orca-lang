/**
 * Orca markdown parser.
 *
 * Parses .orca.md format into MachineDef objects.
 * Supports hierarchical (nested) states and parallel regions.
 */

import type {
  MachineDef,
  StateDef,
  Transition,
  GuardExpression,
  VariableRef,
  ValueRef,
  RegionDef,
  ParallelDef,
  SyncStrategy,
  ActionSignature,
  InvokeDef,
  EffectDef,
} from "./types.js";
import { StateValue } from "./types.js";

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

// ============================================================
// Markdown (.orca.md) Parser
// ============================================================

interface MdHeading { kind: 'heading'; level: number; text: string }
interface MdTable { kind: 'table'; headers: string[]; rows: string[][] }
interface MdBulletList { kind: 'bullets'; items: string[] }
interface MdBlockquote { kind: 'blockquote'; text: string }
interface MdSeparator { kind: 'separator' }

type MdElement = MdHeading | MdTable | MdBulletList | MdBlockquote | MdSeparator;

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

    // Horizontal rule separator
    if (trimmed === '---') {
      elements.push({ kind: 'separator' });
      i++;
      continue;
    }

    // Heading
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      elements.push({ kind: 'heading', level: headingMatch[1].length, text: headingMatch[2].trim() });
      i++;
      continue;
    }

    // Blockquote
    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoteLines.push(lines[i].trim().replace(/^>\s*/, ''));
        i++;
      }
      elements.push({ kind: 'blockquote', text: quoteLines.join('\n') });
      continue;
    }

    // Table
    if (trimmed.startsWith('|')) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        tableLines.push(lines[i].trim());
        i++;
      }
      if (tableLines.length >= 2) {
        const headers = splitTableRow(tableLines[0]);
        const isSeparator = /^\|[\s\-:|]+\|$/.test(tableLines[1]);
        const dataStart = isSeparator ? 2 : 1;
        const rows: string[][] = [];
        for (let j = dataStart; j < tableLines.length; j++) {
          rows.push(splitTableRow(tableLines[j]));
        }
        elements.push({ kind: 'table', headers, rows });
      }
      continue;
    }

    // Bullet list
    if (trimmed.startsWith('- ')) {
      const items: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('- ')) {
        items.push(lines[i].trim().substring(2).trim());
        i++;
      }
      elements.push({ kind: 'bullets', items });
      continue;
    }

    // Skip other text
    i++;
  }

  return elements;
}

function splitTableRow(line: string): string[] {
  const cells = line.split('|').map(c => c.trim());
  if (cells.length > 0 && cells[0] === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

function stripBackticks(text: string): string {
  if (text.startsWith('`') && text.endsWith('`')) return text.slice(1, -1);
  return text;
}

function findColumnIndex(headers: string[], name: string): number {
  return headers.findIndex(h => h.toLowerCase() === name.toLowerCase());
}

function parseMdAnnotations(text: string): {
  isInitial: boolean; isFinal: boolean; isParallel: boolean; syncStrategy?: SyncStrategy
} {
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
      } else if (part.includes('sync:')) {
        // Handle "parallel sync: any_final" format (no comma between annotations)
        if (part.includes('parallel')) isParallel = true;
        const v = part.split('sync:')[1]?.trim();
        if (v === 'all-final' || v === 'all_final') syncStrategy = 'all-final';
        else if (v === 'any-final' || v === 'any_final') syncStrategy = 'any-final';
        else if (v === 'custom') syncStrategy = 'custom';
      } else if (part.includes('parallel')) {
        // Handle "parallel" when combined with other non-sync annotations
        isParallel = true;
      }
    }
  }
  return { isInitial, isFinal, isParallel, syncStrategy };
}

interface MdStateEntry {
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
  _pendingOnError?: string;
  ignoredEvents?: string[];
}

function parseMdStateBullet(entry: MdStateEntry, text: string): void {
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
    const names = text.slice(7).trim().split(',').map(e => e.trim()).filter(Boolean);
    if (!entry.ignoredEvents) entry.ignoredEvents = [];
    entry.ignoredEvents.push(...names);
  } else if (text.startsWith('on_done:')) {
    let val = text.slice(8).trim();
    if (val.startsWith('->')) val = val.slice(2).trim();
    if (entry.invoke) {
      entry.invoke.onDone = val;
    }
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

function buildMdStatesAtLevel(
  entries: MdStateEntry[], startIdx: number, level: number, parentName?: string
): { states: StateDef[]; nextIdx: number } {
  const states: StateDef[] = [];
  let i = startIdx;

  while (i < entries.length) {
    const entry = entries[i];
    if (entry.level < level) break;
    if (entry.type === 'region') break;
    if (entry.level > level) { i++; continue; }

    const state: StateDef = {
      name: entry.name,
      isInitial: entry.isInitial,
      isFinal: entry.isFinal,
      contains: [],
      ignoredEvents: entry.ignoredEvents || [],
    };
    if (parentName) state.parent = parentName;
    if (entry.description) state.description = entry.description;
    if (entry.onEntry) state.onEntry = entry.onEntry;
    if (entry.onExit) state.onExit = entry.onExit;
    if (entry.onDone) state.onDone = entry.onDone;
    if (entry.timeout) state.timeout = entry.timeout;
    if (entry.invoke) state.invoke = entry.invoke;

    i++;

    if (entry.isParallel) {
      const result = buildMdParallelRegions(entries, i, level + 1, entry.name, entry.syncStrategy);
      state.parallel = result.parallelDef;
      i = result.nextIdx;
    } else if (i < entries.length && entries[i].level === level + 1 && entries[i].type === 'state') {
      const result = buildMdStatesAtLevel(entries, i, level + 1, entry.name);
      state.contains = result.states;
      i = result.nextIdx;
    }

    states.push(state);
  }

  return { states, nextIdx: i };
}

function buildMdParallelRegions(
  entries: MdStateEntry[], startIdx: number, regionLevel: number,
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
        const s: StateDef = {
          name: e.name,
          isInitial: e.isInitial,
          isFinal: e.isFinal,
          parent: `${parentName}.${regionName}`,
          contains: [],
          ignoredEvents: e.ignoredEvents || [],
        };
        if (e.description) s.description = e.description;
        if (e.onEntry) s.onEntry = e.onEntry;
        if (e.onExit) s.onExit = e.onExit;
        if (e.timeout) s.timeout = e.timeout;
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

interface GuardToken {
  type: "ident" | "number" | "string" | "op" | "lparen" | "rparen" | "dot" | "eof";
  value: string;
}

function tokenizeGuardExpr(input: string): GuardToken[] {
  const tokens: GuardToken[] = [];
  let i = 0;

  while (i < input.length) {
    if (/\s/.test(input[i])) { i++; continue; }

    if (input[i] === '"' || input[i] === "'") {
      const quote = input[i];
      let str = "";
      i++;
      while (i < input.length && input[i] !== quote) { str += input[i]; i++; }
      i++;
      tokens.push({ type: "string", value: str });
      continue;
    }

    if (i + 1 < input.length) {
      const two = input[i] + input[i + 1];
      if (two === "==" || two === "!=" || two === "<=" || two === ">=") {
        tokens.push({ type: "op", value: two }); i += 2; continue;
      }
    }

    if (input[i] === "<" || input[i] === ">") {
      tokens.push({ type: "op", value: input[i] }); i++; continue;
    }
    if (input[i] === "(") { tokens.push({ type: "lparen", value: "(" }); i++; continue; }
    if (input[i] === ")") { tokens.push({ type: "rparen", value: ")" }); i++; continue; }
    if (input[i] === ".") { tokens.push({ type: "dot", value: "." }); i++; continue; }

    if (/\d/.test(input[i]) || (input[i] === "-" && i + 1 < input.length && /\d/.test(input[i + 1]))) {
      let num = input[i]; i++;
      while (i < input.length && (/\d/.test(input[i]) || input[i] === ".")) { num += input[i]; i++; }
      tokens.push({ type: "number", value: num });
      continue;
    }

    if (/[a-zA-Z_]/.test(input[i])) {
      let ident = "";
      while (i < input.length && /[a-zA-Z0-9_]/.test(input[i])) { ident += input[i]; i++; }
      tokens.push({ type: "ident", value: ident });
      continue;
    }

    i++;
  }

  tokens.push({ type: "eof", value: "" });
  return tokens;
}

function parseGuardExpression(input: string): GuardExpression {
  const tokens = tokenizeGuardExpr(input);
  let pos = 0;

  function peek(): GuardToken { return tokens[pos]; }
  function advance(): GuardToken { return tokens[pos++]; }

  function parseOr(): GuardExpression {
    let left = parseAnd();
    while (peek().type === "ident" && peek().value === "or") { advance(); left = { kind: "or", left, right: parseAnd() }; }
    return left;
  }

  function parseAnd(): GuardExpression {
    let left = parseNot();
    while (peek().type === "ident" && peek().value === "and") { advance(); left = { kind: "and", left, right: parseNot() }; }
    return left;
  }

  function parseNot(): GuardExpression {
    if (peek().type === "ident" && peek().value === "not") { advance(); return { kind: "not", expr: parsePrimary() }; }
    return parsePrimary();
  }

  function parsePrimary(): GuardExpression {
    const tok = peek();

    if (tok.type === "lparen") {
      advance();
      const expr = parseOr();
      if (peek().type === "rparen") advance();
      return expr;
    }

    if (tok.type === "ident" && tok.value === "true") { advance(); return { kind: "true" }; }
    if (tok.type === "ident" && tok.value === "false") { advance(); return { kind: "false" }; }

    const varPath = parseVarPath();

    if (peek().type === "ident" && peek().value === "is") {
      advance();
      if (peek().type === "ident" && peek().value === "not") {
        advance();
        if (peek().type === "ident" && peek().value === "null") advance();
        return { kind: "nullcheck", expr: varPath, isNull: false };
      }
      if (peek().type === "ident" && peek().value === "null") {
        advance();
        return { kind: "nullcheck", expr: varPath, isNull: true };
      }
    }

    if (peek().type === "op") {
      const op = advance().value;
      const right = parseValue();
      if (right.type === "null") {
        return { kind: "nullcheck", expr: varPath, isNull: op === "==" };
      }
      return { kind: "compare", op: mapOp(op), left: varPath, right };
    }

    return { kind: "nullcheck", expr: varPath, isNull: false };
  }

  function parseVarPath(): VariableRef {
    const parts: string[] = [];
    if (peek().type === "ident") {
      parts.push(advance().value);
      while (peek().type === "dot") {
        advance();
        if (peek().type === "ident") {
          parts.push(advance().value);
        }
      }
    }
    return { kind: "variable", path: parts };
  }

  function parseValue(): ValueRef {
    const tok = peek();
    if (tok.type === "number") {
      advance();
      const num = parseFloat(tok.value);
      return { kind: "value", type: "number", value: num };
    }
    if (tok.type === "string") {
      advance();
      return { kind: "value", type: "string", value: tok.value };
    }
    if (tok.type === "ident") {
      advance();
      if (tok.value === "null") return { kind: "value", type: "null", value: null };
      if (tok.value === "true") return { kind: "value", type: "boolean", value: true };
      if (tok.value === "false") return { kind: "value", type: "boolean", value: false };
      return { kind: "value", type: "string", value: tok.value };
    }
    advance();
    return { kind: "value", type: "null", value: null };
  }

  function mapOp(op: string): "eq" | "ne" | "lt" | "gt" | "le" | "ge" {
    switch (op) {
      case "==": return "eq";
      case "!=": return "ne";
      case "<": return "lt";
      case ">": return "gt";
      case "<=": return "le";
      case ">=": return "ge";
      default: return "eq";
    }
  }

  return parseOr();
}

function parseMdActionSignature(name: string, text: string): ActionSignature {
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

function parseMachineFromElements(elements: MdElement[]): MachineDef {
  let machineName = 'unknown';
  const context: Record<string, unknown> = {};
  const events: string[] = [];
  const transitions: Transition[] = [];
  const guards: Record<string, GuardExpression> = {};
  const actions: ActionSignature[] = [];
  const effects: EffectDef[] = [];
  const stateEntries: MdStateEntry[] = [];
  let currentStateEntry: MdStateEntry | null = null;

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];

    if (el.kind === 'heading') {
      // Machine heading
      if (el.level === 1 && el.text.startsWith('machine ')) {
        machineName = el.text.slice(8).trim();
        currentStateEntry = null;
        continue;
      }

      // Section headings
      const sectionName = el.text.toLowerCase();
      if (['context', 'events', 'transitions', 'guards', 'actions', 'effects'].includes(sectionName)) {
        currentStateEntry = null;
        const nextEl = elements[i + 1];

        if (sectionName === 'context' && nextEl?.kind === 'table') {
          const fi = findColumnIndex(nextEl.headers, 'field');
          const ti = findColumnIndex(nextEl.headers, 'type');
          const di = findColumnIndex(nextEl.headers, 'default');
          for (const row of nextEl.rows) {
            const name = row[fi]?.trim() || '';
            const defaultStr = di >= 0 ? row[di]?.trim() : '';
            let defaultValue: unknown = null;
            if (defaultStr) {
              if (/^\d+$/.test(defaultStr)) defaultValue = parseInt(defaultStr, 10);
              else if (/^\d+\.\d+$/.test(defaultStr)) defaultValue = parseFloat(defaultStr);
              else if (defaultStr === 'true' || defaultStr === 'false') defaultValue = defaultStr === 'true';
              else if (defaultStr.startsWith('"') || defaultStr.startsWith("'")) defaultValue = defaultStr.slice(1, -1);
              else defaultValue = defaultStr;
            }
            context[name] = defaultValue;
          }
          i++;
        } else if (sectionName === 'events' && nextEl?.kind === 'bullets') {
          for (const item of nextEl.items) {
            for (const name of item.split(',').map(n => n.trim()).filter(Boolean)) {
              events.push(name);
            }
          }
          i++;
        } else if (sectionName === 'transitions' && nextEl?.kind === 'table') {
          const si = findColumnIndex(nextEl.headers, 'source');
          const ei = findColumnIndex(nextEl.headers, 'event');
          const gi = findColumnIndex(nextEl.headers, 'guard');
          const ti = findColumnIndex(nextEl.headers, 'target');
          const ai = findColumnIndex(nextEl.headers, 'action');
          for (const row of nextEl.rows) {
            const t: Transition = {
              source: row[si]?.trim() || '',
              event: row[ei]?.trim() || '',
              guard: row[gi]?.trim() || undefined,
              target: row[ti]?.trim() || '',
              action: row[ai]?.trim() || undefined,
            };
            if (!t.guard) delete t.guard;
            if (!t.action || t.action === '_') delete t.action;
            transitions.push(t);
          }
          i++;
        } else if (sectionName === 'guards' && nextEl?.kind === 'table') {
          const ni = findColumnIndex(nextEl.headers, 'name');
          const ei = findColumnIndex(nextEl.headers, 'expression');
          for (const row of nextEl.rows) {
            const name = row[ni]?.trim() || '';
            const exprStr = stripBackticks(row[ei]?.trim() || '');
            guards[name] = parseGuardExpression(exprStr);
          }
          i++;
        } else if (sectionName === 'actions' && nextEl?.kind === 'table') {
          const ni = findColumnIndex(nextEl.headers, 'name');
          const si = findColumnIndex(nextEl.headers, 'signature');
          for (const row of nextEl.rows) {
            actions.push(parseMdActionSignature(
              row[ni]?.trim() || '',
              stripBackticks(row[si]?.trim() || '')
            ));
          }
          i++;
        } else if (sectionName === 'effects' && nextEl?.kind === 'table') {
          const ni = findColumnIndex(nextEl.headers, 'name');
          const ii = findColumnIndex(nextEl.headers, 'input');
          const oi = findColumnIndex(nextEl.headers, 'output');
          for (const row of nextEl.rows) {
            effects.push({
              name: stripBackticks(row[ni]?.trim() || ''),
              input: stripBackticks(row[ii]?.trim() || ''),
              output: stripBackticks(row[oi]?.trim() || ''),
            });
          }
          i++;
        }
        continue;
      }

      // State heading
      const stateMatch = el.text.match(/^state\s+(\w+)(.*)$/);
      if (stateMatch) {
        currentStateEntry = {
          type: 'state', level: el.level, name: stateMatch[1],
          ...parseMdAnnotations(stateMatch[2]?.trim() || ''),
        };
        stateEntries.push(currentStateEntry);
        continue;
      }

      // Region heading
      const regionMatch = el.text.match(/^region\s+(\w+)$/);
      if (regionMatch) {
        currentStateEntry = null;
        stateEntries.push({
          type: 'region', level: el.level, name: regionMatch[1],
          isInitial: false, isFinal: false, isParallel: false,
        });
        continue;
      }

      currentStateEntry = null;
      continue;
    }

    // Content belonging to current state
    if (currentStateEntry) {
      if (el.kind === 'blockquote') {
        currentStateEntry.description = el.text;
      } else if (el.kind === 'bullets') {
        for (const item of el.items) parseMdStateBullet(currentStateEntry, item);
      }
    }
  }

  // Build state hierarchy
  const baseLevel = stateEntries.length > 0 ? stateEntries[0].level : 2;
  const states = buildMdStatesAtLevel(stateEntries, 0, baseLevel).states;

  return { name: machineName, context, events, states, transitions, guards, actions, effects };
}

/**
 * Parse Orca markdown (.orca.md) format into a MachineDef.
 * For multi-machine files, returns the first machine.
 */
export function parseOrcaMd(source: string): MachineDef {
  const elements = parseMarkdownStructure(source);

  // Split by separators for multi-machine files
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

  // Parse first chunk as machine
  return parseMachineFromElements(chunks[0] || []);
}

/**
 * Parse Orca markdown (.orca.md) format into multiple MachineDefs.
 * For single-machine files, returns an array with one machine.
 */
export function parseOrcaMdMulti(source: string): MachineDef[] {
  const elements = parseMarkdownStructure(source);

  // Split by separators for multi-machine files
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

  return chunks.map(chunk => parseMachineFromElements(chunk));
}

/**
 * Parse Orca machine definition (markdown format).
 */
export function parseOrcaAuto(source: string): MachineDef {
  return parseOrcaMd(source);
}
