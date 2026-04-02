// Decision Table Verifier
// Checks: completeness, consistency, redundancy, structural integrity, co-location alignment,
// and machine integration (coverage gap + dead guard detection).

import { DecisionTableDef, ConditionDef, CellValue, Rule } from '../parser/dt-ast.js';
import { MachineDef, OrcaFile, ContextField, GuardExpression, ComparisonOp } from '../parser/ast.js';
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

  // int_range conditions cannot be exhaustively enumerated — skip completeness check
  if (dt.conditions.some(c => c.type === 'int_range')) {
    errors.push({
      code: 'DT_COMPLETENESS_SKIPPED',
      message: 'Completeness check skipped: int_range conditions cannot be exhaustively enumerated',
      severity: 'warning',
      location: { decisionTable: dt.name },
      suggestion: 'Manually verify that all numeric ranges are covered without gaps',
    });
    return errors;
  }

  // Calculate total combinations for enum/bool conditions
  let totalCombinations = 1;
  for (const cond of dt.conditions) {
    const values = getConditionValues(cond);
    if (values.length === 0) {
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

    // A rule is redundant if at least one earlier rule overlaps it AND all overlapping
    // earlier rules produce the same actions (meaning first-match would always hit them first
    // with an identical result, so this rule can never change the outcome).
    let hasOverlappingPredecessor = false;
    let allOverlappingHaveSameActions = true;

    for (let prevIdx = 0; prevIdx < ruleIdx; prevIdx++) {
      const prevRule = dt.rules[prevIdx];

      if (!rulesOverlap(prevRule, rule, dt.conditions)) continue;

      hasOverlappingPredecessor = true;

      if (!actionsMatch(prevRule, rule, actionNames)) {
        allOverlappingHaveSameActions = false;
        break;
      }
    }

    if (hasOverlappingPredecessor && allOverlappingHaveSameActions) {
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

// ============================================================
// Co-location Alignment Check
// ============================================================

/**
 * Check that every condition name and output name in a co-located decision table
 * exists as a context field in the machine. When a DT and machine are in the same
 * file, this contract allows action generation to produce fully-wired code.
 */
export function checkDTContextAlignment(
  dt: DecisionTableDef,
  machine: MachineDef
): VerificationError[] {
  const errors: VerificationError[] = [];
  const contextNames = new Set(machine.context.map(f => f.name));

  for (const cond of dt.conditions) {
    if (!contextNames.has(cond.name)) {
      errors.push({
        code: 'DT_CONTEXT_MISMATCH',
        message: `Decision table '${dt.name}' condition '${cond.name}' has no matching context field in machine '${machine.name}'`,
        severity: 'error',
        location: { decisionTable: dt.name, condition: cond.name },
        suggestion: `Add '${cond.name}' to the ## context section, or rename the condition to match an existing context field`,
      });
    }
  }

  for (const action of dt.actions) {
    if (!contextNames.has(action.name)) {
      errors.push({
        code: 'DT_CONTEXT_MISMATCH',
        message: `Decision table '${dt.name}' output '${action.name}' has no matching context field in machine '${machine.name}'`,
        severity: 'error',
        location: { decisionTable: dt.name, action: action.name },
        suggestion: `Add '${action.name}' to the ## context section, or rename the output to match an existing context field`,
      });
    }
  }

  return errors;
}

/**
 * For a file with exactly one machine and one or more decision tables, verify
 * that every DT condition and output name matches a machine context field.
 * Multi-machine files are skipped (ambiguous ownership).
 */
export function checkFileContextAlignment(file: OrcaFile): VerificationError[] {
  if (file.machines.length !== 1 || file.decisionTables.length === 0) {
    return [];
  }
  const machine = file.machines[0];
  const errors: VerificationError[] = [];
  for (const dt of file.decisionTables) {
    errors.push(...checkDTContextAlignment(dt, machine));
  }
  return errors;
}

// ============================================================
// Machine Integration Checks
// ============================================================

/**
 * Get the enumerable values for a machine context field.
 * Returns null for types that cannot be exhaustively enumerated (string, int, decimal).
 * For enum fields, values are stored as a comma-separated defaultValue string.
 */
function getMachineFieldValues(field: ContextField): string[] | null {
  if (field.type.kind === 'bool') return ['true', 'false'];
  if (field.type.kind === 'custom' && field.type.name === 'enum') {
    if (!field.defaultValue) return null;
    const vals = field.defaultValue.split(',').map(v => v.trim()).filter(Boolean);
    return vals.length > 0 ? vals : null;
  }
  return null;
}

/**
 * Generate all combinations of condition values using machine context values as the
 * input domain. Returns null if any condition cannot be enumerated or if the
 * total combinations exceed the safety limit.
 */
function generateMachineContextCombinations(
  dt: DecisionTableDef,
  contextMap: Map<string, ContextField>
): Map<string, string>[] | null {
  const domainPerCondition: string[][] = [];

  for (const cond of dt.conditions) {
    const field = contextMap.get(cond.name);
    if (!field) return null; // Alignment not met — caller should have checked
    const vals = getMachineFieldValues(field);
    if (!vals) return null; // Non-enumerable type
    domainPerCondition.push(vals);
  }

  // Safety limit
  let total = 1;
  for (const vals of domainPerCondition) total *= vals.length;
  if (total > 4096) return null;

  // Cartesian product
  const combos: Map<string, string>[] = [];
  function cartesian(idx: number, current: Map<string, string>): void {
    if (idx === dt.conditions.length) {
      combos.push(new Map(current));
      return;
    }
    const condName = dt.conditions[idx].name;
    for (const val of domainPerCondition[idx]) {
      current.set(condName, val);
      cartesian(idx + 1, current);
      current.delete(condName);
    }
  }
  cartesian(0, new Map());
  return combos;
}

/**
 * DT_COVERAGE_GAP: Decision table must cover all input combinations the machine
 * context can actually produce. Uses machine enum/bool values as the authoritative
 * domain — stricter than DT_INCOMPLETE which only checks DT-declared values.
 */
function checkDTCoverageGap(
  dt: DecisionTableDef,
  contextMap: Map<string, ContextField>
): VerificationError[] {
  const errors: VerificationError[] = [];

  const combos = generateMachineContextCombinations(dt, contextMap);
  if (!combos) return errors; // Non-enumerable conditions or too many combinations

  for (const combo of combos) {
    const matched = dt.rules.some(rule => ruleMatchesInput(rule, dt.conditions, combo));
    if (!matched) {
      const comboDesc = [...combo.entries()].map(([k, v]) => `${k}=${v}`).join(', ');
      errors.push({
        code: 'DT_COVERAGE_GAP',
        message: `Decision table '${dt.name}' has no rule for machine context combination: ${comboDesc}`,
        severity: 'error',
        location: { decisionTable: dt.name },
        suggestion: `Add a rule covering this combination, or add a catch-all row using '-' wildcards`,
      });
    }
  }

  return errors;
}

/**
 * Recursively collect all equality comparisons from a guard expression.
 * Returns tuples of (fieldName, op, comparedValue) for any `ctx.X op Y` node.
 */
function collectFieldComparisons(
  expr: GuardExpression
): Array<{ field: string; op: ComparisonOp; value: string }> {
  if (expr.kind === 'compare') {
    // Only handle ctx.fieldName comparisons
    if (expr.left.path.length === 2 && expr.left.path[0] === 'ctx') {
      return [{ field: expr.left.path[1], op: expr.op, value: String(expr.right.value) }];
    }
    return [];
  }
  if (expr.kind === 'not') return collectFieldComparisons(expr.expr);
  if (expr.kind === 'and' || expr.kind === 'or') {
    return [...collectFieldComparisons(expr.left), ...collectFieldComparisons(expr.right)];
  }
  return [];
}

/**
 * DT_GUARD_DEAD: A guard that compares a DT output field against a value the DT
 * never produces is a dead guard — it can never be true immediately after the
 * DT action fires. Reported as a warning since another action might set the field.
 */
function checkDTGuardDead(dt: DecisionTableDef, machine: MachineDef): VerificationError[] {
  const errors: VerificationError[] = [];

  // Build output domain: field → set of values the DT can produce
  const outputDomain = new Map<string, Set<string>>();
  for (const action of dt.actions) {
    outputDomain.set(action.name, new Set<string>());
  }
  for (const rule of dt.rules) {
    for (const [name, value] of rule.actions) {
      outputDomain.get(name)?.add(value);
    }
  }

  const outputFields = new Set(dt.actions.map(a => a.name));

  for (const guardDef of machine.guards) {
    const comparisons = collectFieldComparisons(guardDef.expression);
    for (const { field, op, value } of comparisons) {
      if (!outputFields.has(field)) continue; // Not a DT output field
      if (op !== 'eq') continue;              // Only equality checks are conclusive

      const possible = outputDomain.get(field)!;
      if (!possible.has(value)) {
        const possibleList = [...possible].join(', ') || '(none)';
        errors.push({
          code: 'DT_GUARD_DEAD',
          message: `Guard '${guardDef.name}' tests '${field} == ${value}' but '${dt.name}' never outputs '${value}' for '${field}' (possible: ${possibleList})`,
          severity: 'warning',
          location: { decisionTable: dt.name, condition: field },
          suggestion: `Update '${dt.name}' to produce '${value}' for '${field}', or remove this guard`,
        });
      }
    }
  }

  return errors;
}

/**
 * Check DT integration with the machine: coverage gap (DT must handle all machine
 * context inputs) and dead guards (guards on DT output fields must be satisfiable).
 * Only runs when exactly one machine is present and the DT is fully aligned.
 * Multi-machine files are skipped (ambiguous ownership).
 */
export function checkDTMachineIntegration(file: OrcaFile): VerificationError[] {
  if (file.machines.length !== 1 || file.decisionTables.length === 0) {
    return [];
  }
  const machine = file.machines[0];
  const contextMap = new Map(machine.context.map(f => [f.name, f]));
  const errors: VerificationError[] = [];

  for (const dt of file.decisionTables) {
    // Only verify DTs that are fully aligned with machine context
    const allAligned = [...dt.conditions, ...dt.actions].every(item => contextMap.has(item.name));
    if (!allAligned) continue;

    errors.push(...checkDTCoverageGap(dt, contextMap));
    errors.push(...checkDTGuardDead(dt, machine));
  }

  return errors;
}
