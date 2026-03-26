/**
 * Orca DSL parser.
 *
 * Parses Orca machine definition text into MachineDef objects.
 * Supports hierarchical (nested) states.
 * Supports both .orca (DSL) and .orca.md (markdown) formats.
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
} from "./types.js";
import { StateValue } from "./types.js";

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

export function parseOrca(source: string): MachineDef {
  const lines = source.trim().split("\n");
  let pos = 0;
  let machineName = "unknown";

  // Find machine name
  while (pos < lines.length) {
    const line = lines[pos].trim();
    if (line.startsWith("machine ")) {
      const parts = line.split(/\s+/);
      if (parts.length >= 2) {
        machineName = parts[1];
      }
      pos++;
      break;
    }
    pos++;
  }

  // Parse remaining sections
  const context: Record<string, unknown> = {};
  const events: string[] = [];
  const states: StateDef[] = [];
  const transitions: Transition[] = [];
  const guards: Record<string, GuardExpression> = {};
  const actions: ActionSignature[] = [];

  while (pos < lines.length) {
    const line = lines[pos].trim();

    if (!line) {
      pos++;
      continue;
    }

    if (line.startsWith("context")) {
      const result = collectBlock(lines, pos);
      pos = result.pos;
      Object.assign(context, parseContext(result.content));
    } else if (line.startsWith("events")) {
      const result = collectBlock(lines, pos);
      pos = result.pos;
      events.push(...parseEvents(result.content));
    } else if (line.startsWith("state")) {
      // Parse all top-level states
      const result = parseAllStates(lines, pos);
      states.push(...result.states);
      pos = result.pos;
    } else if (line.startsWith("transitions")) {
      const result = collectBlock(lines, pos);
      pos = result.pos;
      transitions.push(...parseTransitions(result.content));
    } else if (line.startsWith("guards")) {
      const result = collectBlock(lines, pos);
      pos = result.pos;
      Object.assign(guards, parseGuards(result.content));
    } else if (line.startsWith("actions")) {
      const result = collectBlock(lines, pos);
      pos = result.pos;
      actions.push(...parseActions(result.content));
    } else {
      pos++;
    }
  }

  return {
    name: machineName,
    context,
    events,
    states,
    transitions,
    guards,
    actions,
  };
}

interface ActionSignature {
  name: string;
  parameters: string[];
  returnType: string;
  hasEffect: boolean;
  effectType?: string;
}

interface CollectBlockResult {
  content: string;
  pos: number;
}

function collectBlock(lines: string[], start: number): CollectBlockResult {
  let pos = start + 1; // Skip header line
  let braceCount = 1;

  while (pos < lines.length && braceCount > 0) {
    const line = lines[pos].trim();
    braceCount += (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
    pos++;
  }

  const content = lines.slice(start + 1, pos - 1).join("\n");
  return { content, pos };
}

interface ParseAllStatesResult {
  states: StateDef[];
  pos: number;
}

function parseAllStates(lines: string[], start: number): ParseAllStatesResult {
  const states: StateDef[] = [];
  let pos = start;

  while (pos < lines.length) {
    const line = lines[pos].trim();

    if (!line) {
      pos++;
      continue;
    }

    if (!line.startsWith("state")) {
      break;
    }

    const result = parseState(lines, pos);
    if (result.state) {
      states.push(result.state);
    }
    pos = result.endPos;
  }

  return { states, pos };
}

interface ParseStateResult {
  state: StateDef | null;
  consumed: number;
  endPos: number;
}

function parseState(lines: string[], start: number): ParseStateResult {
  if (start >= lines.length) {
    return { state: null, consumed: 0, endPos: start };
  }

  const headerLine = lines[start].trim();
  if (!headerLine.startsWith("state")) {
    return { state: null, consumed: 0, endPos: start + 1 };
  }

  // Parse header: state name [annotations]
  const match = headerLine.match(/^state\s+(\w+)(?:\s+\[(.*?)\])?/);
  if (!match) {
    return { state: null, consumed: 0, endPos: start + 1 };
  }

  const name = match[1];
  const annotationsStr = match[2] || "";

  const isInitial = annotationsStr.split(",").includes("initial");
  const isFinal = annotationsStr.split(",").includes("final");

  const state: StateDef = {
    name,
    isInitial,
    isFinal,
    contains: [],
    ignoredEvents: [],
  };

  // Check if state has a body
  if (!headerLine.includes("{")) {
    // No body - single line state
    return { state, consumed: 1, endPos: start + 1 };
  }

  // Collect body content until matching brace
  const bodyLines: string[] = [];
  let pos = start + 1;
  const headerBraceCount = headerLine.match(/{/g)?.length ?? 0 - (headerLine.match(/}/g)?.length ?? 0);
  let braceCount = headerBraceCount;

  while (pos < lines.length && braceCount > 0) {
    const line = lines[pos].trim();
    braceCount += (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;

    if (braceCount > 0 && line) {
      bodyLines.push(line);
    }

    pos++;
  }

  // Parse body properties and collect nested state lines
  const nestedStateLines: string[] = [];
  for (const bodyLine of bodyLines) {
    if (!bodyLine) continue;
    if (bodyLine.startsWith("state ")) {
      nestedStateLines.push(bodyLine);
    } else if (bodyLine.startsWith("description:")) {
      const parts = bodyLine.split(":", 1);
      state.description = parts[1]?.trim().replace(/^["']|["']$/g, "") || "";
    } else if (bodyLine.startsWith("on_entry:")) {
      const m = bodyLine.match(/^on_entry:\s*->\s*(\w+)/);
      if (m) {
        state.onEntry = m[1];
      }
    } else if (bodyLine.startsWith("on_exit:")) {
      const m = bodyLine.match(/^on_exit:\s*->\s*(\w+)/);
      if (m) {
        state.onExit = m[1];
      }
    } else if (bodyLine.startsWith("timeout:")) {
      const m = bodyLine.match(/^timeout:\s*(\d+)(?:s)?\s*->\s*(\w+)/);
      if (m) {
        state.timeout = { duration: m[1], target: m[2] };
      }
    } else if (bodyLine.startsWith("ignore:")) {
      const eventsStr = bodyLine.replace(/^ignore:\s*/, "");
      const ignored = eventsStr.split(",").map((e) => e.trim()).filter(Boolean);
      state.ignoredEvents.push(...ignored);
    } else if (bodyLine.startsWith("on_done:")) {
      const m = bodyLine.match(/^on_done:\s*->\s*(\w+)/);
      if (m) {
        state.onDone = m[1];
      }
    }
  }

  // Parse parallel block from bodyLines
  const parallelResult = parseParallelBlock(bodyLines, name);
  if (parallelResult) {
    state.parallel = parallelResult;
  }

  // Parse nested states directly from bodyLines (only if no parallel)
  if (!state.parallel && nestedStateLines.length > 0) {
    const nestedStates = parseNestedStates(bodyLines, name);
    if (nestedStates.length > 0) {
      state.contains = nestedStates;
    }
  }

  return { state, consumed: pos - start, endPos: pos };
}

function parseNestedStates(bodyLines: string[], parentName: string): StateDef[] {
  const nestedStates: StateDef[] = [];
  let i = 0;

  while (i < bodyLines.length) {
    const line = bodyLines[i]?.trim();

    if (!line || line === "}") {
      i++;
      continue;
    }

    if (!line.startsWith("state ")) {
      i++;
      continue;
    }

    const result = parseNestedState(bodyLines, i);
    if (result.state) {
      result.state.parent = parentName;
      nestedStates.push(result.state);
      i += result.consumed;
    } else {
      i++;
    }
  }

  return nestedStates;
}

function parseNestedState(bodyLines: string[], start: number): { state: StateDef | null; consumed: number } {
  if (start >= bodyLines.length) {
    return { state: null, consumed: 0 };
  }

  const headerLine = bodyLines[start]?.trim();
  if (!headerLine.startsWith("state ")) {
    return { state: null, consumed: 0 };
  }

  const match = headerLine.match(/^state\s+(\w+)(?:\s+\[(.*?)\])?/);
  if (!match) {
    return { state: null, consumed: 0 };
  }

  const name = match[1];
  const annotationsStr = match[2] || "";

  const isInitial = annotationsStr.split(",").includes("initial");
  const isFinal = annotationsStr.split(",").includes("final");

  const state: StateDef = {
    name,
    isInitial,
    isFinal,
    contains: [],
    ignoredEvents: [],
  };

  // Check if state has a body
  if (!headerLine.includes("{") && !headerLine.includes("}")) {
    return { state, consumed: 1 };
  }

  // Find body bounds
  let bodyStart = start + 1;
  let bodyEnd = bodyStart;
  let braceCount = 1;

  while (bodyEnd < bodyLines.length && braceCount > 0) {
    const line = bodyLines[bodyEnd].trim();
    braceCount += (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
    bodyEnd++;
  }

  // Extract body content
  const bodyContent: string[] = [];
  for (let j = bodyStart; j < bodyEnd - 1; j++) {
    const line = bodyLines[j].trim();
    if (line && line !== "{" && line !== "}") {
      bodyContent.push(line);
    }
  }

  // Parse body properties
  const innerNestedLines: string[] = [];
  for (const bodyLine of bodyContent) {
    if (bodyLine.startsWith("state ")) {
      innerNestedLines.push(bodyLine);
    } else if (bodyLine.startsWith("description:")) {
      state.description = bodyLine.split(":", 1)[1].trim().replace(/^["']|["']$/g, "");
    } else if (bodyLine.startsWith("on_entry:")) {
      const m = bodyLine.match(/^on_entry:\s*->\s*(\w+)/);
      if (m) {
        state.onEntry = m[1];
      }
    } else if (bodyLine.startsWith("on_exit:")) {
      const m = bodyLine.match(/^on_exit:\s*->\s*(\w+)/);
      if (m) {
        state.onExit = m[1];
      }
    } else if (bodyLine.startsWith("timeout:")) {
      const m = bodyLine.match(/^timeout:\s*(\d+)(?:s)?\s*->\s*(\w+)/);
      if (m) {
        state.timeout = { duration: m[1], target: m[2] };
      }
    } else if (bodyLine.startsWith("ignore:")) {
      const eventsStr = bodyLine.replace(/^ignore:\s*/, "");
      const ignored = eventsStr.split(",").map((e) => e.trim()).filter(Boolean);
      state.ignoredEvents.push(...ignored);
    } else if (bodyLine.startsWith("on_done:")) {
      const m = bodyLine.match(/^on_done:\s*->\s*(\w+)/);
      if (m) {
        state.onDone = m[1];
      }
    }
  }

  // Parse parallel block from body content
  const parallelResult = parseParallelBlock(bodyContent, name);
  if (parallelResult) {
    state.parallel = parallelResult;
  }

  // Recursively parse nested states (only if no parallel)
  if (!state.parallel && innerNestedLines.length > 0) {
    const innerNested = parseNestedStates(bodyContent, name);
    if (innerNested.length > 0) {
      state.contains = innerNested;
    }
  }

  const consumed = bodyEnd - start;
  return { state, consumed };
}

function parseParallelBlock(bodyLines: string[], parentName: string): ParallelDef | null {
  // Find the "parallel" line
  let parallelStart = -1;
  let sync: SyncStrategy | undefined;

  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i].trim();
    if (line.startsWith("parallel")) {
      parallelStart = i;
      // Check for sync annotation: parallel [sync: all_final] {
      const syncMatch = line.match(/\[sync:\s*(\w+)\]/);
      if (syncMatch) {
        const val = syncMatch[1];
        if (val === "all_final") sync = "all-final";
        else if (val === "any_final") sync = "any-final";
        else if (val === "custom") sync = "custom";
      }
      break;
    }
  }

  if (parallelStart === -1) return null;

  // Collect all lines inside the parallel block
  let braceCount = 0;
  let blockStart = parallelStart;
  const parallelLines: string[] = [];

  for (let i = parallelStart; i < bodyLines.length; i++) {
    const line = bodyLines[i].trim();
    braceCount += (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
    if (i > parallelStart) {
      parallelLines.push(line);
    }
    if (braceCount === 0 && i > parallelStart) break;
  }

  // Parse regions from the parallel lines
  const regions: RegionDef[] = [];
  let i = 0;

  while (i < parallelLines.length) {
    const line = parallelLines[i].trim();
    if (line.startsWith("region ")) {
      const nameMatch = line.match(/^region\s+(\w+)/);
      if (nameMatch) {
        const regionName = nameMatch[1];

        // Collect region body lines (exclude the closing } of the region itself)
        let regionBraceCount = 0;
        const regionBodyLines: string[] = [];
        let j = i;
        for (; j < parallelLines.length; j++) {
          const rLine = parallelLines[j].trim();
          regionBraceCount += (rLine.match(/{/g) || []).length - (rLine.match(/}/g) || []).length;
          if (j > i && regionBraceCount > 0) regionBodyLines.push(rLine);
          if (regionBraceCount === 0 && j > i) break;
        }

        // Parse states from region body
        const regionStates = parseNestedStates(
          regionBodyLines,
          `${parentName}.${regionName}`
        );

        regions.push({ name: regionName, states: regionStates });
        i = j + 1;
        continue;
      }
    }
    i++;
  }

  if (regions.length === 0) return null;
  return { regions, sync };
}

function parseContext(content: string): Record<string, unknown> {
  const context: Record<string, unknown> = {};

  for (const line of content.trim().split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "{" || trimmed === "}") {
      continue;
    }

    const match = trimmed.match(/^(\w+)\s*:\s*(\w+)(?:\s*=\s*(.*))?$/);
    if (match) {
      const [, name, typeStr, defaultStr] = match;
      let defaultValue: unknown = null;

      if (defaultStr) {
        const stripped = defaultStr.trim();
        if (stripped.startsWith('"') || stripped.startsWith("'")) {
          defaultValue = stripped.slice(1, -1);
        } else if (stripped === "true" || stripped === "false") {
          defaultValue = stripped === "true";
        } else if (/^\d+$/.test(stripped)) {
          defaultValue = parseInt(stripped, 10);
        } else if (/^\d+\.\d+$/.test(stripped)) {
          defaultValue = parseFloat(stripped);
        } else {
          defaultValue = stripped;
        }
      }

      context[name] = defaultValue;
    }
  }

  return context;
}

function parseEvents(content: string): string[] {
  const events: string[] = [];

  for (const line of content.trim().split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "{" || trimmed === "}") {
      continue;
    }

    const parts = trimmed.split(",").map((p) => p.trim());
    for (const part of parts) {
      if (part) {
        events.push(part);
      }
    }
  }

  return events;
}

function parseTransitions(content: string): Transition[] {
  const transitions: Transition[] = [];

  for (const line of content.trim().split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "{" || trimmed === "}") {
      continue;
    }

    const match = trimmed.match(
      /^(\w+)\s*\+\s*(\w+)(?:\s*\[([^\]]+)\])?\s*->\s*(\w+)(?:\s*:\s*(\w+))?$/
    );
    if (match) {
      transitions.push({
        source: match[1],
        event: match[2],
        guard: match[3],
        target: match[4],
        action: match[5],
      });
    }
  }

  return transitions;
}

function parseGuards(content: string): Record<string, GuardExpression> {
  const guards: Record<string, GuardExpression> = {};

  for (const line of content.trim().split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "{" || trimmed === "}") {
      continue;
    }

    const match = trimmed.match(/^(\w+)\s*:\s*(.+)$/);
    if (match) {
      const [, name, exprStr] = match;
      guards[name] = parseGuardExpression(exprStr.trim());
    }
  }

  return guards;
}

// --- Guard expression parser ---
// Grammar:
//   expr     = or_expr
//   or_expr  = and_expr ('or' and_expr)*
//   and_expr = not_expr ('and' not_expr)*
//   not_expr = 'not' primary | primary
//   primary  = '(' expr ')' | 'true' | 'false' | comparison
//   comparison = var_path (op value)?
//   var_path = IDENT ('.' IDENT)*
//   op       = '==' | '!=' | '<' | '>' | '<=' | '>='
//   value    = NUMBER | STRING | 'true' | 'false' | 'null'

interface GuardToken {
  type: "ident" | "number" | "string" | "op" | "lparen" | "rparen" | "dot" | "eof";
  value: string;
}

function tokenizeGuardExpr(input: string): GuardToken[] {
  const tokens: GuardToken[] = [];
  let i = 0;

  while (i < input.length) {
    // Skip whitespace
    if (/\s/.test(input[i])) {
      i++;
      continue;
    }

    // String literal
    if (input[i] === '"' || input[i] === "'") {
      const quote = input[i];
      let str = "";
      i++;
      while (i < input.length && input[i] !== quote) {
        str += input[i];
        i++;
      }
      i++; // skip closing quote
      tokens.push({ type: "string", value: str });
      continue;
    }

    // Two-char operators
    if (i + 1 < input.length) {
      const two = input[i] + input[i + 1];
      if (two === "==" || two === "!=" || two === "<=" || two === ">=") {
        tokens.push({ type: "op", value: two });
        i += 2;
        continue;
      }
    }

    // Single-char operators
    if (input[i] === "<" || input[i] === ">") {
      tokens.push({ type: "op", value: input[i] });
      i++;
      continue;
    }

    if (input[i] === "(") {
      tokens.push({ type: "lparen", value: "(" });
      i++;
      continue;
    }
    if (input[i] === ")") {
      tokens.push({ type: "rparen", value: ")" });
      i++;
      continue;
    }
    if (input[i] === ".") {
      tokens.push({ type: "dot", value: "." });
      i++;
      continue;
    }

    // Number
    if (/\d/.test(input[i]) || (input[i] === "-" && i + 1 < input.length && /\d/.test(input[i + 1]))) {
      let num = input[i];
      i++;
      while (i < input.length && (/\d/.test(input[i]) || input[i] === ".")) {
        num += input[i];
        i++;
      }
      tokens.push({ type: "number", value: num });
      continue;
    }

    // Identifier (includes keywords: true, false, null, and, or, not)
    if (/[a-zA-Z_]/.test(input[i])) {
      let ident = "";
      while (i < input.length && /[a-zA-Z0-9_]/.test(input[i])) {
        ident += input[i];
        i++;
      }
      tokens.push({ type: "ident", value: ident });
      continue;
    }

    // Skip unknown characters
    i++;
  }

  tokens.push({ type: "eof", value: "" });
  return tokens;
}

function parseGuardExpression(input: string): GuardExpression {
  const tokens = tokenizeGuardExpr(input);
  let pos = 0;

  function peek(): GuardToken {
    return tokens[pos];
  }

  function advance(): GuardToken {
    return tokens[pos++];
  }

  function parseOr(): GuardExpression {
    let left = parseAnd();
    while (peek().type === "ident" && peek().value === "or") {
      advance();
      const right = parseAnd();
      left = { kind: "or", left, right };
    }
    return left;
  }

  function parseAnd(): GuardExpression {
    let left = parseNot();
    while (peek().type === "ident" && peek().value === "and") {
      advance();
      const right = parseNot();
      left = { kind: "and", left, right };
    }
    return left;
  }

  function parseNot(): GuardExpression {
    if (peek().type === "ident" && peek().value === "not") {
      advance();
      return { kind: "not", expr: parsePrimary() };
    }
    return parsePrimary();
  }

  function parsePrimary(): GuardExpression {
    const tok = peek();

    // Parenthesized expression
    if (tok.type === "lparen") {
      advance();
      const expr = parseOr();
      if (peek().type === "rparen") advance();
      return expr;
    }

    // Literals
    if (tok.type === "ident" && tok.value === "true") {
      advance();
      return { kind: "true" };
    }
    if (tok.type === "ident" && tok.value === "false") {
      advance();
      return { kind: "false" };
    }

    // Variable path, possibly followed by comparison
    const varPath = parseVarPath();

    // Check for "is null" / "is not null"
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

    // Comparison operator
    if (peek().type === "op") {
      const op = advance().value;
      const right = parseValue();
      // Special case: != null and == null
      if (right.type === "null") {
        return { kind: "nullcheck", expr: varPath, isNull: op === "==" };
      }
      return { kind: "compare", op: mapOp(op), left: varPath, right };
    }

    // Bare variable = truthy check (not null)
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
      // Unknown ident as string
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

function parseActions(content: string): ActionSignature[] {
  const actions: ActionSignature[] = [];

  for (const line of content.trim().split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "{" || trimmed === "}") {
      continue;
    }

    const match = trimmed.match(
      /^(\w+)\s*:\s*(?:\(([^)]*)\))?\s*->\s*(\w+)(?:\s*\+\s*Effect<(\w+)>)?$/
    );
    if (match) {
      const [, name, paramsStr, returnType, effectType] = match;

      const parameters: string[] = [];
      if (paramsStr) {
        for (const p of paramsStr.split(",")) {
          const paramName = p.trim().split(":")[0].trim();
          if (paramName) {
            parameters.push(paramName);
          }
        }
      }

      actions.push({
        name,
        parameters,
        returnType,
        hasEffect: effectType !== undefined,
        effectType,
      });
    }
  }

  return actions;
}

// ============================================================
// Markdown (.orca.md) Parser
// ============================================================

interface MdHeading { kind: 'heading'; level: number; text: string }
interface MdTable { kind: 'table'; headers: string[]; rows: string[][] }
interface MdBulletList { kind: 'bullets'; items: string[] }
interface MdBlockquote { kind: 'blockquote'; text: string }

type MdElement = MdHeading | MdTable | MdBulletList | MdBlockquote;

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
    entry.onDone = val;
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

/**
 * Parse Orca markdown (.orca.md) format into a MachineDef.
 */
export function parseOrcaMd(source: string): MachineDef {
  const elements = parseMarkdownStructure(source);

  let machineName = 'unknown';
  const context: Record<string, unknown> = {};
  const events: string[] = [];
  const transitions: Transition[] = [];
  const guards: Record<string, GuardExpression> = {};
  const actions: ActionSignature[] = [];
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
      if (['context', 'events', 'transitions', 'guards', 'actions'].includes(sectionName)) {
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

  return { name: machineName, context, events, states, transitions, guards, actions };
}

/**
 * Auto-detect format and parse Orca machine definition.
 * Uses filename extension if provided, otherwise sniffs content.
 */
export function parseOrcaAuto(source: string, filename?: string): MachineDef {
  if (filename?.endsWith('.orca.md') || filename?.endsWith('.md')) {
    return parseOrcaMd(source);
  }
  if (filename?.endsWith('.orca')) {
    return parseOrca(source);
  }
  // Content sniffing: markdown starts with # heading
  if (/^\s*#\s+machine\s+/m.test(source)) {
    return parseOrcaMd(source);
  }
  return parseOrca(source);
}
