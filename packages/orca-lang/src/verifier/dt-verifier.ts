// Decision Table Verifier
// Checks: completeness, consistency, redundancy, and structural integrity

import { DecisionTableDef, ConditionDef, CellValue, Rule } from '../parser/dt-ast.js';
import { VerificationError, VerificationResult, Severity } from './types.js';

// Helper to get all values for a condition
function getConditionValues(condition: ConditionDef): string[] {
  if (condition.type === 'bool') {
    return condition.values.length > 0 ? condition.values : ['true', 'false'];
  }
  return condition.values;
}

// Check if a cell matches a given value
function cellMatches(cell: CellValue, value: string): boolean {
  switch (cell.kind) {
    case 'any':
      return true;
    case 'exact':
      return cell.value === value;
    case 'negated':
      return cell.value !== value;
    case 'set':
      return cell.values.includes(value);
  }
}

// Check if a rule's conditions cover a specific input combination
function ruleMatchesInput(rule: Rule, conditionDefs: ConditionDef[], input: Map<string, string>): boolean {
  for (const cond of conditionDefs) {
    const cell = rule.conditions.get(cond.name);
    if (!cell) continue; // No condition for this column means "any"
    const expectedValue = input.get(cond.name);
    if (!cellMatches(cell, expectedValue || '')) {
      return false;
    }
  }
  return true;
}

// Check if two rules overlap (can match the same input)
function rulesOverlap(rule1: Rule, rule2: Rule, conditionDefs: ConditionDef[]): boolean {
  for (const cond of conditionDefs) {
    const cell1 = rule1.conditions.get(cond.name);
    const cell2 = rule2.conditions.get(cond.name);

    // If either rule doesn't constrain this condition, they overlap on it
    if (!cell1 || cell1.kind === 'any') continue;
    if (!cell2 || cell2.kind === 'any') continue;

    // Check if cells intersect
    if (!cellsIntersect(cell1, cell2)) {
      return false; // No overlap on this condition means no overall overlap
    }
  }
  return true; // All constrained conditions intersect
}

// Check if two cells intersect (can match the same value)
function cellsIntersect(cell1: CellValue, cell2: CellValue): boolean {
  // Any intersects with everything
  if (cell1.kind === 'any' || cell2.kind === 'any') return true;

  // Exact vs Exact
  if (cell1.kind === 'exact' && cell2.kind === 'exact') {
    return cell1.value === cell2.value;
  }

  // Exact vs Negated
  if (cell1.kind === 'exact' && cell2.kind === 'negated') {
    return cell2.value !== cell1.value;
  }
  if (cell1.kind === 'negated' && cell2.kind === 'exact') {
    return cell1.value !== cell2.value;
  }

  // Exact vs Set
  if (cell1.kind === 'exact' && cell2.kind === 'set') {
    return cell2.values.includes(cell1.value);
  }
  if (cell1.kind === 'set' && cell2.kind === 'exact') {
    return cell1.values.includes(cell2.value);
  }

  // Negated vs Negated
  if (cell1.kind === 'negated' && cell2.kind === 'negated') {
    return cell1.value !== cell2.value;
  }

  // Negated vs Set
  if (cell1.kind === 'negated' && cell2.kind === 'set') {
    return !cell2.values.includes(cell1.value);
  }
  if (cell1.kind === 'set' && cell2.kind === 'negated') {
    return !cell1.values.includes(cell2.value);
  }

  // Set vs Set
  if (cell1.kind === 'set' && cell2.kind === 'set') {
    return cell1.values.some(v => cell2.values.includes(v));
  }

  return true;
}

// Generate all possible combinations of condition values
function generateCombinations(conditionDefs: ConditionDef[]): Map<string, string>[] {
  const combinations: Map<string, string>[] = [];
  const values = conditionDefs.map(c => getConditionValues(c));

  function* cartesian(index: number, current: Map<string, string>): Generator<Map<string, string>> {
    if (index === conditionDefs.length) {
      yield new Map(current);
      return;
    }
    const condName = conditionDefs[index].name;
    for (const val of values[index]) {
      current.set(condName, val);
      yield* cartesian(index + 1, current);
      current.delete(condName);
    }
  }

  return [...cartesian(0, new Map())];
}

// Find which rules match a given input
function findMatchingRules(dt: DecisionTableDef, input: Map<string, string>): Rule[] {
  return dt.rules.filter(rule => ruleMatchesInput(rule, dt.conditions, input));
}

// Check if two rules produce the same action outputs
function actionsMatch(rule1: Rule, rule2: Rule, actionNames: string[]): boolean {
  for (const actionName of actionNames) {
    const val1 = rule1.actions.get(actionName);
    const val2 = rule2.actions.get(actionName);
    if (val1 !== val2) return false;
  }
  return true;
}

// ============================================================
// Structural Checks
// ============================================================

function checkStructural(dt: DecisionTableDef): VerificationError[] {
  const errors: VerificationError[] = [];

  // DT_NO_CONDITIONS
  if (dt.conditions.length === 0) {
    errors.push({
      code: 'DT_NO_CONDITIONS',
      message: 'Decision table has no conditions declared',
      severity: 'error',
      location: { decisionTable: dt.name },
      suggestion: 'Add a ## conditions section with at least one condition',
    });
  }

  // DT_NO_ACTIONS
  if (dt.actions.length === 0) {
    errors.push({
      code: 'DT_NO_ACTIONS',
      message: 'Decision table has no actions declared',
      severity: 'error',
      location: { decisionTable: dt.name },
      suggestion: 'Add an ## actions section with at least one action',
    });
  }

  // DT_EMPTY_RULES
  if (dt.rules.length === 0) {
    errors.push({
      code: 'DT_EMPTY_RULES',
      message: 'Decision table has no rules',
      severity: 'warning',
      location: { decisionTable: dt.name },
      suggestion: 'Add rules to the ## rules section',
    });
    return errors; // No point checking rule content if there are no rules
  }

  const conditionNames = new Set(dt.conditions.map(c => c.name));
  const actionNames = new Set(dt.actions.map(a => a.name));
  const ruleConditionNames = new Set<string>();
  const ruleActionNames = new Set<string>();

  // Check each rule
  for (let ruleIdx = 0; ruleIdx < dt.rules.length; ruleIdx++) {
    const rule = dt.rules[ruleIdx];
    const ruleNum = rule.number ?? ruleIdx + 1;

    // Check condition columns
    for (const [condName] of rule.conditions) {
      ruleConditionNames.add(condName);

      // DT_UNKNOWN_CONDITION_COLUMN
      if (!conditionNames.has(condName)) {
        errors.push({
          code: 'DT_UNKNOWN_CONDITION_COLUMN',
          message: `Rule ${ruleNum} has unknown condition column "${condName}"`,
          severity: 'warning',
          location: { decisionTable: dt.name, rule: ruleNum, condition: condName },
          suggestion: `Remove or rename the column to match a declared condition`,
        });
      } else {
        // DT_UNKNOWN_CONDITION_VALUE
        const cond = dt.conditions.find(c => c.name === condName)!;
        const cell = rule.conditions.get(condName)!;

        // Skip value validation for int_range — values are ranges, not enum values
        if (cell.kind !== 'any' && cond.type !== 'string' && cond.type !== 'int_range') {
          const validValues = getConditionValues(cond);
          if (cell.kind === 'exact' && !validValues.includes(cell.value)) {
            errors.push({
              code: 'DT_UNKNOWN_CONDITION_VALUE',
              message: `Rule ${ruleNum} condition "${condName}" has value "${cell.value}" not in declared values`,
              severity: 'error',
              location: { decisionTable: dt.name, rule: ruleNum, condition: condName },
              suggestion: `Change to one of: ${validValues.join(', ')}`,
            });
          } else if (cell.kind === 'negated' && !validValues.includes(cell.value)) {
            errors.push({
              code: 'DT_UNKNOWN_CONDITION_VALUE',
              message: `Rule ${ruleNum} condition "${condName}" negates "${cell.value}" which is not in declared values`,
              severity: 'error',
              location: { decisionTable: dt.name, rule: ruleNum, condition: condName },
              suggestion: `Change to negate one of: ${validValues.join(', ')}`,
            });
          } else if (cell.kind === 'set') {
            for (const v of cell.values) {
              if (!validValues.includes(v)) {
                errors.push({
                  code: 'DT_UNKNOWN_CONDITION_VALUE',
                  message: `Rule ${ruleNum} condition "${condName}" has value "${v}" not in declared values`,
                  severity: 'error',
                  location: { decisionTable: dt.name, rule: ruleNum, condition: condName },
                  suggestion: `Change to one of: ${validValues.join(', ')}`,
                });
              }
            }
          }
        }
      }
    }

    // Check action columns
    for (const [actionName] of rule.actions) {
      ruleActionNames.add(actionName);

      // DT_UNKNOWN_ACTION_COLUMN
      if (!actionNames.has(actionName)) {
        errors.push({
          code: 'DT_UNKNOWN_ACTION_COLUMN',
          message: `Rule ${ruleNum} has unknown action column "${actionName}"`,
          severity: 'warning',
          location: { decisionTable: dt.name, rule: ruleNum, action: actionName },
          suggestion: `Remove or rename the column to match a declared action`,
        });
      } else {
        // DT_UNKNOWN_ACTION_VALUE
        const action = dt.actions.find(a => a.name === actionName)!;
        const value = rule.actions.get(actionName)!;

        if (action.type === 'enum' && action.values) {
          if (!action.values.includes(value)) {
            errors.push({
              code: 'DT_UNKNOWN_ACTION_VALUE',
              message: `Rule ${ruleNum} action "${actionName}" has value "${value}" not in declared values`,
              severity: 'error',
              location: { decisionTable: dt.name, rule: ruleNum, action: actionName },
              suggestion: `Change to one of: ${action.values.join(', ')}`,
            });
          }
        }
      }
    }
  }

  // DT_MISSING_CONDITION_COLUMN
  for (const condName of conditionNames) {
    if (!ruleConditionNames.has(condName)) {
      errors.push({
        code: 'DT_MISSING_CONDITION_COLUMN',
        message: `Condition "${condName}" is declared but has no column in the rules table`,
        severity: 'warning',
        location: { decisionTable: dt.name, condition: condName },
        suggestion: `Add a "${condName}" column to the rules table`,
      });
    }
  }

  // DT_MISSING_ACTION_COLUMN
  for (const actionName of actionNames) {
    if (!ruleActionNames.has(actionName)) {
      errors.push({
        code: 'DT_MISSING_ACTION_COLUMN',
        message: `Action "${actionName}" is declared but has no corresponding column in the rules table`,
        severity: 'warning',
        location: { decisionTable: dt.name, action: actionName },
        suggestion: `Add a "→ ${actionName}" column to the rules table`,
      });
    }
  }

  // DT_DUPLICATE_RULE
  for (let i = 0; i < dt.rules.length; i++) {
    for (let j = i + 1; j < dt.rules.length; j++) {
      const rule1 = dt.rules[i];
      const rule2 = dt.rules[j];

      // Check if conditions are identical
      let identical = true;
      if (rule1.conditions.size !== rule2.conditions.size) {
        identical = false;
      } else {
        for (const [name, cell1] of rule1.conditions) {
          const cell2 = rule2.conditions.get(name);
          if (!cell2 || !cellsEqual(cell1, cell2)) {
            identical = false;
            break;
          }
        }
      }

      if (identical) {
        const rule1Num = rule1.number ?? i + 1;
        const rule2Num = rule2.number ?? j + 1;
        errors.push({
          code: 'DT_DUPLICATE_RULE',
          message: `Rule ${rule1Num} and Rule ${rule2Num} have identical condition patterns`,
          severity: 'warning',
          location: { decisionTable: dt.name, rule: rule2Num },
          suggestion: `Remove or modify one of the duplicate rules`,
        });
      }
    }
  }

  return errors;
}

function cellsEqual(cell1: CellValue, cell2: CellValue): boolean {
  if (cell1.kind !== cell2.kind) return false;
  // Now cell1 and cell2 have the same kind, narrow both
  const kind = cell1.kind;
  if (kind === 'any') return true;
  if (kind === 'exact') {
    return (cell1 as { kind: 'exact'; value: string }).value === (cell2 as { kind: 'exact'; value: string }).value;
  }
  if (kind === 'negated') {
    return (cell1 as { kind: 'negated'; value: string }).value === (cell2 as { kind: 'negated'; value: string }).value;
  }
  if (kind === 'set') {
    const s1 = cell1 as { kind: 'set'; values: string[] };
    const s2 = cell2 as { kind: 'set'; values: string[] };
    return s1.values.length === s2.values.length && s1.values.every(v => s2.values.includes(v));
  }
  return true;
}

// ============================================================
// Completeness Check
// ============================================================

function checkCompleteness(dt: DecisionTableDef): VerificationError[] {
  const errors: VerificationError[] = [];

  if (dt.conditions.length === 0) return errors; // Already reported in structural

  // Calculate total combinations
  let totalCombinations = 1;
  for (const cond of dt.conditions) {
    const values = getConditionValues(cond);
    if (values.length === 0) {
      // Wildcard-only condition - no limit
      totalCombinations = Infinity;
      break;
    }
    totalCombinations *= values.length;
    if (totalCombinations > 4096) break;
  }

  if (totalCombinations > 4096) {
    errors.push({
      code: 'DT_COMPLETENESS_SKIPPED',
      message: `Completeness check skipped: ${totalCombinations} combinations exceed limit of 4096`,
      severity: 'warning',
      location: { decisionTable: dt.name },
      suggestion: 'Consider simplifying conditions or using wildcards to reduce combination count',
    });
    return errors;
  }

  // Generate all combinations and check coverage
  const combinations = generateCombinations(dt.conditions);
  const actionNames = dt.actions.map(a => a.name);

  for (const combo of combinations) {
    const matchingRules = findMatchingRules(dt, combo);

    if (matchingRules.length === 0) {
      const comboDesc = [...combo.entries()].map(([k, v]) => `${k}=${v}`).join(', ');
      errors.push({
        code: 'DT_INCOMPLETE',
        message: `Missing coverage for: ${comboDesc}`,
        severity: 'error',
        location: { decisionTable: dt.name },
        suggestion: `Add a rule to cover this condition combination`,
      });
    }
  }

  return errors;
}

// ============================================================
// Consistency Check
// ============================================================

function checkConsistency(dt: DecisionTableDef): VerificationError[] {
  const errors: VerificationError[] = [];
  const isAllMatch = dt.policy === 'all-match';

  for (let i = 0; i < dt.rules.length; i++) {
    for (let j = i + 1; j < dt.rules.length; j++) {
      const rule1 = dt.rules[i];
      const rule2 = dt.rules[j];

      // Check if rules overlap
      if (!rulesOverlap(rule1, rule2, dt.conditions)) continue;

      // Rules overlap - check if actions agree
      const actionNames = dt.actions.map(a => a.name);
      const actionsAgree = actionsMatch(rule1, rule2, actionNames);

      if (!actionsAgree) {
        const rule1Num = rule1.number ?? i + 1;
        const rule2Num = rule2.number ?? j + 1;
        const severity: Severity = isAllMatch ? 'error' : 'warning';
        const code = isAllMatch ? 'DT_INCONSISTENT' : 'DT_INCONSISTENT';

        const overlappingConditions: string[] = [];
      for (const cond of dt.conditions) {
        const cell1 = rule1.conditions.get(cond.name);
        const cell2 = rule2.conditions.get(cond.name);
        if (cell1 && cell2 && cellsIntersect(cell1, cell2)) {
          overlappingConditions.push(cond.name);
        }
      }

        errors.push({
          code,
          message: `Rules ${rule1Num} and ${rule2Num} can match the same input but produce different results`,
          severity,
          location: { decisionTable: dt.name, rule: rule2Num },
          suggestion: `For ${isAllMatch ? 'all-match' : 'first-match'} policy: review overlapping rules on conditions: ${overlappingConditions.join(', ')}`,
        });
      }
    }
  }

  return errors;
}

// ============================================================
// Redundancy Check
// ============================================================

function checkRedundancy(dt: DecisionTableDef): VerificationError[] {
  const errors: VerificationError[] = [];

  // For each rule, check if it's fully covered by earlier rules with same actions
  for (let ruleIdx = 1; ruleIdx < dt.rules.length; ruleIdx++) {
    const rule = dt.rules[ruleIdx];
    const ruleNum = rule.number ?? ruleIdx + 1;
    const actionNames = dt.actions.map(a => a.name);

    // Check if all inputs matched by this rule are also matched by an earlier rule with same actions
    let isRedundant = true;

    for (let prevIdx = 0; prevIdx < ruleIdx; prevIdx++) {
      const prevRule = dt.rules[prevIdx];

      // Check if prevRule overlaps with this rule
      if (!rulesOverlap(prevRule, rule, dt.conditions)) continue;

      // prevRule overlaps - check if it has same actions
      if (!actionsMatch(prevRule, rule, actionNames)) {
        isRedundant = false;
        break;
      }

      // prevRule has same actions but may not cover all cases this rule covers
      // For a rule to be redundant, prevRule must cover a superset of its conditions
      // Actually, in first-match: if prevRule overlaps AND has same actions, then this rule is redundant
      // because any input matching this rule will either match prevRule first (same actions = ok)
      // or match this rule first (but prevRule comes first, so prevRule wins)
    }

    if (isRedundant) {
      errors.push({
        code: 'DT_REDUNDANT',
        message: `Rule ${ruleNum} is redundant — earlier rules cover all its cases with the same actions`,
        severity: 'warning',
        location: { decisionTable: dt.name, rule: ruleNum },
        suggestion: `Remove this rule or make it more specific`,
      });
    }
  }

  return errors;
}

// ============================================================
// Main Verifier
// ============================================================

export function verifyDecisionTable(dt: DecisionTableDef): VerificationResult {
  const errors: VerificationError[] = [];

  // Run structural checks first
  errors.push(...checkStructural(dt));

  // Run semantic checks (only if basic structure is valid)
  const hasNoConditions = dt.conditions.length === 0;
  const hasNoActions = dt.actions.length === 0;

  if (!hasNoConditions && !hasNoActions) {
    errors.push(...checkCompleteness(dt));
    errors.push(...checkConsistency(dt));
    errors.push(...checkRedundancy(dt));
  }

  return {
    valid: !errors.some(e => e.severity === 'error'),
    errors,
  };
}

export function verifyDecisionTables(dts: DecisionTableDef[]): VerificationResult {
  const allErrors: VerificationError[] = [];

  for (const dt of dts) {
    const result = verifyDecisionTable(dt);
    allErrors.push(...result.errors);
  }

  return {
    valid: !allErrors.some(e => e.severity === 'error'),
    errors: allErrors,
  };
}
