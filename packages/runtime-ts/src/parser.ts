/**
 * Orca DSL parser.
 *
 * Parses Orca machine definition text into MachineDef objects.
 * Supports hierarchical (nested) states.
 */

import type {
  MachineDef,
  StateDef,
  Transition,
  GuardExpression,
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
    }
  }

  // Parse nested states directly from bodyLines
  if (nestedStateLines.length > 0) {
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
    }
  }

  // Recursively parse nested states
  if (innerNestedLines.length > 0) {
    const innerNested = parseNestedStates(bodyContent, name);
    if (innerNested.length > 0) {
      state.contains = innerNested;
    }
  }

  const consumed = bodyEnd - start;
  return { state, consumed };
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
      const stripped = exprStr.trim();

      if (stripped === "true") {
        guards[name] = { kind: "true" };
      } else if (stripped === "false") {
        guards[name] = { kind: "false" };
      } else {
        guards[name] = { kind: "true" }; // Default to true for complex expressions
      }
    }
  }

  return guards;
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
