// Decision Table Parser
// Parses ## conditions, ## actions, ## rules sections from markdown elements

import {
  ConditionDef, ConditionType, ActionOutputDef, ActionType,
  CellValue, Rule, DecisionTableDef,
} from './dt-ast.js';

interface MdHeading { kind: 'heading'; level: number; text: string; line: number }
interface MdTable { kind: 'table'; headers: string[]; rows: string[][]; line: number }
interface MdBulletList { kind: 'bullets'; items: string[]; line: number }
interface MdBlockquote { kind: 'blockquote'; text: string; line: number }
interface MdParagraph { kind: 'paragraph'; text: string; line: number }
interface MdSeparator { kind: 'separator'; line: number }

type MdElement = MdHeading | MdTable | MdBulletList | MdBlockquote | MdParagraph | MdSeparator;

function findColumnIndex(headers: string[], name: string): number {
  return headers.findIndex(h => h.toLowerCase() === name.toLowerCase());
}

// --- Cell Value Parsing ---

function parseNumericCell(text: string): CellValue | null {
  // Suffix form: 750+ means >=750
  const suffixPlus = text.match(/^(-?\d+(?:\.\d+)?)\+$/);
  if (suffixPlus) {
    return { kind: 'compare', op: '>=', value: parseFloat(suffixPlus[1]) };
  }

  // Comparison operators: >=750, <=0.3, >100, <600
  const cmpMatch = text.match(/^(>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)$/);
  if (cmpMatch) {
    return { kind: 'compare', op: cmpMatch[1] as '>' | '>=' | '<' | '<=', value: parseFloat(cmpMatch[2]) };
  }

  // Range with .. separator: 1..50 (inclusive both ends)
  const dotRange = text.match(/^(-?\d+(?:\.\d+)?)\s*\.\.\s*(-?\d+(?:\.\d+)?)$/);
  if (dotRange) {
    return { kind: 'range', low: parseFloat(dotRange[1]), high: parseFloat(dotRange[2]), lowInc: true, highInc: true };
  }

  // Range with - separator for numbers: 700-749, 0.3-0.4
  // Must have at least one side that looks numeric (digit-starting).
  // Negative numbers on the left are ambiguous with subtraction — require left >= 0.
  const dashRange = text.match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/);
  if (dashRange) {
    return { kind: 'range', low: parseFloat(dashRange[1]), high: parseFloat(dashRange[2]), lowInc: true, highInc: true };
  }

  return null;
}

function parseCellValue(text: string | undefined, condType?: ConditionType): CellValue {
  if (!text || text.trim() === '' || text.trim() === '-') {
    return { kind: 'any' };
  }

  const trimmed = text.trim();

  // Negated: !value (bare '!' with no value falls through to exact match)
  if (trimmed.startsWith('!')) {
    const negatedValue = trimmed.slice(1);
    if (negatedValue) {
      return { kind: 'negated', value: negatedValue };
    }
  }

  // Numeric range/compare patterns — only attempt for numeric condition types
  if (condType === 'int_range' || condType === 'decimal_range') {
    const numeric = parseNumericCell(trimmed);
    if (numeric) return numeric;
  }

  // Set: a,b,c
  if (trimmed.includes(',')) {
    return { kind: 'set', values: trimmed.split(',').map(v => v.trim()).filter(Boolean) };
  }

  // Exact match
  return { kind: 'exact', value: trimmed };
}

// --- Section Parsers ---

function parseConditionsTable(table: MdTable): ConditionDef[] {
  const nameIdx = findColumnIndex(table.headers, 'name');
  const typeIdx = findColumnIndex(table.headers, 'type');
  const valuesIdx = findColumnIndex(table.headers, 'values');

  return table.rows.map(row => {
    const name = (nameIdx >= 0 ? row[nameIdx] : '') || '';
    const typeStr = (typeIdx >= 0 ? row[typeIdx] : '') || 'string';
    const valuesStr = (valuesIdx >= 0 ? row[valuesIdx] : '') || '';

    const type: ConditionType = typeStr.trim() as ConditionType;

    // Bool conditions auto-populate values ['true', 'false'] when Values column is empty
    let values: string[];
    let range: { min: number; max: number } | undefined;

    if (type === 'bool') {
      values = valuesStr.trim() ? valuesStr.split(',').map(v => v.trim()) : ['true', 'false'];
    } else if (type === 'int_range' || type === 'decimal_range') {
      // Parse min..max format (integers or decimals)
      const rangeMatch = valuesStr.match(/(-?\d+(?:\.\d+)?)\s*\.\.\s*(-?\d+(?:\.\d+)?)/);
      if (rangeMatch) {
        range = { min: parseFloat(rangeMatch[1]), max: parseFloat(rangeMatch[2]) };
        values = [];
      } else {
        values = [];
      }
    } else {
      // enum or string - comma-separated values
      values = valuesStr ? valuesStr.split(',').map(v => v.trim()).filter(Boolean) : [];
    }

    const condition: ConditionDef = { name: name.trim(), type, values };
    if (range) condition.range = range;

    return condition;
  }).filter(c => c.name !== '');
}

function parseActionsTable(table: MdTable): ActionOutputDef[] {
  const nameIdx = findColumnIndex(table.headers, 'name');
  const typeIdx = findColumnIndex(table.headers, 'type');
  const descIdx = findColumnIndex(table.headers, 'description');
  const valuesIdx = findColumnIndex(table.headers, 'values');

  return table.rows.map(row => {
    const name = (nameIdx >= 0 ? row[nameIdx] : '') || '';
    const typeStr = (typeIdx >= 0 ? row[typeIdx] : '') || 'string';
    const desc = descIdx >= 0 ? (row[descIdx] || '').trim() : '';
    const valuesStr = valuesIdx >= 0 ? (row[valuesIdx] || '').trim() : '';

    const type: ActionType = typeStr.trim() as ActionType;
    const action: ActionOutputDef = {
      name: name.trim(),
      type,
      description: desc || undefined,
    };

    if (valuesStr && type === 'enum') {
      action.values = valuesStr.split(',').map(v => v.trim()).filter(Boolean);
    }

    return action;
  }).filter(a => a.name !== '');
}

function parseRulesTable(
  table: MdTable,
  conditionNames: Set<string>,
  actionNames: Set<string>,
  conditionDefs?: ConditionDef[]
): { rules: Rule[]; warnings: string[] } {
  const warnings: string[] = [];
  const rules: Rule[] = [];

  // Determine column types from headers
  const columnTypes: Array<{ name: string; type: 'condition' | 'action' | 'skip' }> = [];

  for (const header of table.headers) {
    const trimmed = header.trim();
    const lower = trimmed.toLowerCase();

    if (lower === '#') {
      columnTypes.push({ name: '#', type: 'skip' });
    } else if (trimmed.startsWith('→ ') || trimmed.startsWith('-> ')) {
      // Action column - strip prefix
      const actionName = trimmed.replace(/^→\s*/, '').replace(/^->\s*/, '');
      columnTypes.push({ name: actionName, type: 'action' });

      if (!actionNames.has(actionName)) {
        warnings.push(`Unknown action column: "${actionName}" (not declared in ## actions)`);
      }
    } else {
      // Condition column
      columnTypes.push({ name: trimmed, type: 'condition' });

      if (!conditionNames.has(trimmed)) {
        warnings.push(`Unknown condition column: "${trimmed}" (not declared in ## conditions)`);
      }
    }
  }

  // Parse each row
  for (let rowIdx = 0; rowIdx < table.rows.length; rowIdx++) {
    const row = table.rows[rowIdx];
    const rule: Rule = {
      conditions: new Map(),
      actions: new Map(),
    };

    for (let colIdx = 0; colIdx < columnTypes.length && colIdx < row.length; colIdx++) {
      const col = columnTypes[colIdx];
      const cell = row[colIdx];

      if (col.type === 'skip') {
        // Rule numbering column - parse as optional number
        const num = parseInt(cell?.trim() || '', 10);
        if (!isNaN(num)) {
          rule.number = num;
        }
      } else if (col.type === 'condition') {
        const condDef = conditionDefs?.find(c => c.name === col.name);
        const cellValue = parseCellValue(cell, condDef?.type);
        rule.conditions.set(col.name, cellValue);
      } else if (col.type === 'action') {
        const value = cell?.trim() || '';
        if (value) {
          rule.actions.set(col.name, value);
        }
      }
    }

    rules.push(rule);
  }

  return { rules, warnings };
}

// --- Main Decision Table Parser ---

export function parseDecisionTable(elements: MdElement[]): { decisionTable: DecisionTableDef; warnings: string[] } {
  let tableName = '';
  let description: string | undefined;
  let conditions: ConditionDef[] = [];
  let actions: ActionOutputDef[] = [];
  let rules: Rule[] = [];
  let policy: 'first-match' | 'all-match' = 'first-match';
  const warnings: string[] = [];

  // Track current section
  let currentSection: 'conditions' | 'actions' | 'rules' | null = null;
  let currentTable: MdTable | null = null;

  // Collect description from paragraphs before first ## heading
  const descriptionParts: string[] = [];

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];

    if (el.kind === 'heading') {
      if (el.level === 1 && el.text.startsWith('decision_table ')) {
        tableName = el.text.slice(15).trim();
        continue;
      }

      if (el.level === 2) {
        const sectionName = el.text.toLowerCase();

        // Before processing first section, capture accumulated description
        if (currentSection === null && descriptionParts.length > 0) {
          description = descriptionParts.join(' ').trim();
        }

        if (sectionName === 'conditions') {
          currentSection = 'conditions';
        } else if (sectionName === 'actions') {
          currentSection = 'actions';
        } else if (sectionName === 'rules') {
          currentSection = 'rules';
        } else if (sectionName === 'metadata') {
          currentSection = null; // metadata doesn't have a table
        } else {
          currentSection = null;
        }
        currentTable = null;
        continue;
      }

      // Reset section on unknown headings
      currentSection = null;
      currentTable = null;
    }

    // Accumulate description from paragraphs and blockquotes before first section
    if (currentSection === null) {
      if (el.kind === 'paragraph') {
        descriptionParts.push(el.text);
      } else if (el.kind === 'blockquote') {
        descriptionParts.push(el.text);
      }
    }

    // Capture tables for current section
    if (el.kind === 'table' && currentSection !== null) {
      if (currentSection === 'conditions') {
        conditions = parseConditionsTable(el);
      } else if (currentSection === 'actions') {
        actions = parseActionsTable(el);
      } else if (currentSection === 'rules') {
        const result = parseRulesTable(el, new Set(conditions.map(c => c.name)), new Set(actions.map(a => a.name)), conditions);
        rules = result.rules;
        warnings.push(...result.warnings);
      }
      currentTable = el;
    }
  }

  const decisionTable: DecisionTableDef = {
    name: tableName,
    description,
    conditions,
    actions,
    rules,
    policy,
  };

  return { decisionTable, warnings };
}

// Parse a chunk of markdown elements that represents a single decision table
// Returns null if the chunk doesn't start with # decision_table
export function parseDecisionTableChunk(chunk: MdElement[]): DecisionTableDef | null {
  if (chunk.length === 0) return null;

  const firstHeading = chunk.find(el => el.kind === 'heading' && el.level === 1) as MdHeading | undefined;
  if (!firstHeading || !firstHeading.text.startsWith('decision_table ')) {
    return null;
  }

  const { decisionTable } = parseDecisionTable(chunk);
  return decisionTable;
}
