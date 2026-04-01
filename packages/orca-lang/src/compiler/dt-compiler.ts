// Decision Table Compiler
// Compiles verified decision tables to TypeScript evaluator functions or JSON

import { DecisionTableDef, CellValue } from '../parser/dt-ast.js';

// Convert camelCase or snake_case to PascalCase
function toPascalCase(name: string): string {
  return name
    .split(/[_-]/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}

// Generate TypeScript type for input interface
function generateInputType(dt: DecisionTableDef): string {
  const lines: string[] = [];
  lines.push(`export interface ${toPascalCase(dt.name)}Input {`);

  for (const cond of dt.conditions) {
    const typeStr = generateTypeScriptType(cond.type, cond.values);
    lines.push(`  ${cond.name}: ${typeStr};`);
  }

  lines.push('}');
  return lines.join('\n');
}

// Generate TypeScript type for output interface
function generateOutputType(dt: DecisionTableDef): string {
  const lines: string[] = [];
  lines.push(`export interface ${toPascalCase(dt.name)}Output {`);

  for (const action of dt.actions) {
    const typeStr = generateTypeScriptType(action.type, action.values || []);
    lines.push(`  ${action.name}: ${typeStr};`);
  }

  lines.push('}');
  return lines.join('\n');
}

// Generate TypeScript type string from condition/action type
function generateTypeScriptType(type: string, values: string[]): string {
  if (type === 'bool') {
    return 'boolean';
  }
  if (type === 'enum') {
    return values.length > 0 ? values.map(v => `'${v}'`).join(' | ') : 'string';
  }
  if (type === 'int_range') {
    return 'number';
  }
  return 'string';
}

// Generate condition check code
function generateConditionCheck(condName: string, condType: string, cell: CellValue): string {
  switch (cell.kind) {
    case 'any':
      return ''; // No condition needed

    case 'exact':
      // For bool type, compare to boolean; for others, compare to string
      if (condType === 'bool') {
        return `input.${condName} === ${cell.value}`;
      }
      return `input.${condName} === '${cell.value}'`;

    case 'negated':
      if (condType === 'bool') {
        return `input.${condName} !== ${cell.value}`;
      }
      return `input.${condName} !== '${cell.value}'`;

    case 'set':
      const checks = cell.values.map(v => {
        if (condType === 'bool') {
          return `input.${condName} === ${v}`;
        }
        return `input.${condName} === '${v}'`;
      }).join(' || ');
      return `(${checks})`;

    default:
      return '';
  }
}

// Generate return statement for a rule
function generateReturnStatement(dt: DecisionTableDef, ruleIndex: number): string {
  const rule = dt.rules[ruleIndex];
  const actionEntries: string[] = [];

  for (const action of dt.actions) {
    const value = rule.actions.get(action.name);
    if (value !== undefined) {
      if (action.type === 'bool') {
        // Bool actions use true/false
        actionEntries.push(`      ${action.name}: ${value}`);
      } else {
        actionEntries.push(`      ${action.name}: '${value}'`);
      }
    }
  }

  return `return {\n${actionEntries.join(',\n')}\n    };`;
}

// Compile to TypeScript evaluator function
export function compileDecisionTableToTypeScript(dt: DecisionTableDef): string {
  const inputTypeName = `${toPascalCase(dt.name)}Input`;
  const outputTypeName = `${toPascalCase(dt.name)}Output`;
  const functionName = `evaluate${toPascalCase(dt.name)}`;

  const lines: string[] = [];

  // Input interface
  lines.push(generateInputType(dt));
  lines.push('');

  // Output interface
  lines.push(generateOutputType(dt));
  lines.push('');

  // Evaluator function
  lines.push(`export function ${functionName}(input: ${inputTypeName}): ${outputTypeName} | null {`);

  // Generate rule checks
  for (let ruleIdx = 0; ruleIdx < dt.rules.length; ruleIdx++) {
    const rule = dt.rules[ruleIdx];
    const ruleNum = rule.number ?? ruleIdx + 1;

    // Collect condition checks
    const checks: string[] = [];
    for (const [condName, cell] of rule.conditions) {
      const condDef = dt.conditions.find(c => c.name === condName);
      const condType = condDef?.type ?? 'string';
      const check = generateConditionCheck(condName, condType, cell);
      if (check) {
        checks.push(check);
      }
    }

    // Build the if statement
    if (checks.length === 0) {
      // Rule with all wildcards - always matches
      lines.push(`  // Rule ${ruleNum}: always matches`);
      lines.push(`  {`);
      lines.push(`    ${generateReturnStatement(dt, ruleIdx)}`);
      lines.push(`  }`);
    } else {
      lines.push(`  // Rule ${ruleNum}`);
      const conditionStr = checks.join(' && ');
      lines.push(`  if (${conditionStr}) {`);
      lines.push(`    ${generateReturnStatement(dt, ruleIdx)}`);
      lines.push(`  }`);
    }
  }

  // Default return null
  lines.push('  return null; // no rule matched');
  lines.push('}');

  return lines.join('\n');
}

// Compile to JSON
export interface DTJSONRule {
  conditions: Record<string, string>;
  actions: Record<string, string>;
}

export interface DTJSON {
  name: string;
  conditions: Array<{
    name: string;
    type: string;
    values: string[];
  }>;
  actions: Array<{
    name: string;
    type: string;
    values?: string[];
  }>;
  rules: DTJSONRule[];
  policy: 'first-match' | 'all-match';
}

export function compileDecisionTableToJSON(dt: DecisionTableDef): string {
  const json: DTJSON = {
    name: dt.name,
    conditions: dt.conditions.map(c => ({
      name: c.name,
      type: c.type,
      values: c.values,
    })),
    actions: dt.actions.map(a => {
      const result: { name: string; type: string; values?: string[] } = {
        name: a.name,
        type: a.type,
      };
      if (a.values) {
        result.values = a.values;
      }
      return result;
    }),
    rules: dt.rules.map(rule => {
      // Omit wildcard conditions (kind: 'any')
      const conditions: Record<string, string> = {};
      for (const [name, cell] of rule.conditions) {
        if (cell.kind === 'exact') {
          conditions[name] = cell.value;
        } else if (cell.kind === 'negated') {
          conditions[name] = `!${cell.value}`;
        } else if (cell.kind === 'set') {
          conditions[name] = cell.values.join(',');
        }
        // 'any' is omitted
      }

      const actions: Record<string, string> = {};
      for (const [name, value] of rule.actions) {
        actions[name] = value;
      }

      return { conditions, actions };
    }),
    policy: dt.policy,
  };

  return JSON.stringify(json, null, 2);
}
