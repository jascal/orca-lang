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

// Check if a cell matches a given value (string or numeric)
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
    case 'compare': {
      const num = parseFloat(value);
      if (isNaN(num)) return false;
      switch (cell.op) {
        case '>':  return num > cell.value;
        case '>=': return num >= cell.value;
        case '<':  return num < cell.value;
        case '<=': return num <= cell.value;
      }
      return false;
    }
    case 'range': {
      const num = parseFloat(value);
      if (isNaN(num)) return false;
      const aboveLow = cell.lowInc ? num >= cell.low : num > cell.low;
      const belowHigh = cell.highInc ? num <= cell.high : num < cell.high;
      return aboveLow && belowHigh;
    }
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

  // --- Numeric cell intersection helpers ---

  // Convert a cell to a numeric interval [low, high] (inclusive flags)
  // Returns null for non-numeric kinds.
  function toInterval(cell: CellValue): { low: number; high: number; lowInc: boolean; highInc: boolean } | null {
    if (cell.kind === 'range') {
      return { low: cell.low, high: cell.high, lowInc: cell.lowInc, highInc: cell.highInc };
    }
    if (cell.kind === 'compare') {
      switch (cell.op) {
        case '>=': return { low: cell.value, high: Infinity, lowInc: true, highInc: false };
        case '>':  return { low: cell.value, high: Infinity, lowInc: false, highInc: false };
        case '<=': return { low: -Infinity, high: cell.value, lowInc: false, highInc: true };
        case '<':  return { low: -Infinity, high: cell.value, lowInc: false, highInc: false };
      }
    }
    if (cell.kind === 'exact') {
      const n = parseFloat(cell.value);
      if (!isNaN(n)) return { low: n, high: n, lowInc: true, highInc: true };
    }
    return null;
  }

  function intervalsOverlap(
    a: { low: number; high: number; lowInc: boolean; highInc: boolean },
    b: { low: number; high: number; lowInc: boolean; highInc: boolean }
  ): boolean {
    // a.high < b.low or a.high == b.low and at least one exclusive → no overlap
    if (a.high < b.low || b.high < a.low) return false;
    if (a.high === b.low && !(a.highInc && b.lowInc)) return false;
    if (b.high === a.low && !(b.highInc && a.lowInc)) return false;
    return true;
  }

  const iv1 = toInterval(cell1);
  const iv2 = toInterval(cell2);
  if (iv1 && iv2) return intervalsOverlap(iv1, iv2);

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
  if (kind === 'compare') {
    const c1 = cell1 as { kind: 'compare'; op: string; value: number };
    const c2 = cell2 as { kind: 'compare'; op: string; value: number };
    return c1.op === c2.op && c1.value === c2.value;
  }
  if (kind === 'range') {
    const r1 = cell1 as { kind: 'range'; low: number; high: number; lowInc: boolean; highInc: boolean };
    const r2 = cell2 as { kind: 'range'; low: number; high: number; lowInc: boolean; highInc: boolean };
    return r1.low === r2.low && r1.high === r2.high && r1.lowInc === r2.lowInc && r1.highInc === r2.highInc;
  }
  return true;
}

// ============================================================
// Completeness Check
// ============================================================

// --- Interval-based completeness for numeric conditions ---

interface Interval {
  low: number;
  high: number;
  lowInc: boolean;
  highInc: boolean;
}

/** Convert a CellValue to a list of intervals it covers within the given domain. */
function cellToIntervals(cell: CellValue, domain: Interval): Interval[] {
  switch (cell.kind) {
    case 'any':
      return [domain];
    case 'compare':
      switch (cell.op) {
        case '>=': return [{ low: Math.max(cell.value, domain.low), high: domain.high, lowInc: cell.value >= domain.low, highInc: domain.highInc }];
        case '>':  return [{ low: Math.max(cell.value, domain.low), high: domain.high, lowInc: false, highInc: domain.highInc }];
        case '<=': return [{ low: domain.low, high: Math.min(cell.value, domain.high), lowInc: domain.lowInc, highInc: cell.value <= domain.high }];
        case '<':  return [{ low: domain.low, high: Math.min(cell.value, domain.high), lowInc: domain.lowInc, highInc: false }];
      }
      return [];
    case 'range':
      return [{
        low: Math.max(cell.low, domain.low),
        high: Math.min(cell.high, domain.high),
        lowInc: cell.low > domain.low ? cell.lowInc : domain.lowInc,
        highInc: cell.high < domain.high ? cell.highInc : domain.highInc,
      }];
    case 'exact': {
      const v = parseFloat(cell.value);
      if (isNaN(v)) return [];
      if (v >= domain.low && v <= domain.high) return [{ low: v, high: v, lowInc: true, highInc: true }];
      return [];
    }
    default:
      return [];
  }
}

/** Check if a sorted list of non-overlapping intervals covers the entire domain without gaps.
 *  For integer types, adjacent integers (e.g., [a,N] and [N+1,b]) are treated as contiguous. */
function checkIntervalCoverage(intervals: Interval[], domain: Interval, isInteger: boolean): Interval[] {
  if (intervals.length === 0) return [domain];

  // Sort by low bound, then by inclusive (inclusive first)
  const sorted = [...intervals].sort((a, b) => {
    if (a.low !== b.low) return a.low - b.low;
    if (a.lowInc && !b.lowInc) return -1;
    if (!a.lowInc && b.lowInc) return 1;
    return 0;
  });

  // Merge overlapping/adjacent intervals
  const merged: Interval[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = sorted[i];
    // Adjacent or overlapping: prev.high >= curr.low (or == with at least one inclusive)
    // For integers: [a, N] and [N+1, b] are adjacent
    const adjacent = prev.high > curr.low
      || (prev.high === curr.low && (prev.highInc || curr.lowInc))
      || (isInteger && prev.highInc && curr.lowInc && curr.low === prev.high + 1);
    if (adjacent) {
      if (curr.high > prev.high) {
        prev.high = curr.high;
        prev.highInc = curr.highInc;
      } else if (curr.high === prev.high) {
        prev.highInc = prev.highInc || curr.highInc;
      }
    } else {
      merged.push({ ...curr });
    }
  }

  // Check for gaps against domain
  const gaps: Interval[] = [];
  let cursor = domain.low;
  let cursorInc = domain.lowInc;

  for (const iv of merged) {
    // Is there a gap between cursor and this interval's start?
    if (iv.low > cursor || (iv.low === cursor && !iv.lowInc && cursorInc)) {
      // Gap starts just after the cursor (cursor itself is covered if cursorInc)
      gaps.push({ low: cursor, high: iv.low, lowInc: !cursorInc, highInc: !iv.lowInc });
    }
    if (iv.high > cursor || (iv.high === cursor && iv.highInc && !cursorInc)) {
      cursor = iv.high;
      cursorInc = iv.highInc;
    }
  }

  if (cursor < domain.high || (cursor === domain.high && !cursorInc && domain.highInc)) {
    gaps.push({ low: cursor, high: domain.high, lowInc: !cursorInc, highInc: domain.highInc });
  }

  return gaps;
}

/** Check completeness of numeric conditions on a single numeric axis.
 *  For each numeric condition, project the rules onto that axis (treating all
 *  other conditions as wildcards) and verify there are no gaps in the domain. */
function checkNumericCompleteness(dt: DecisionTableDef): VerificationError[] {
  const errors: VerificationError[] = [];

  for (const cond of dt.conditions) {
    if (cond.type !== 'int_range' && cond.type !== 'decimal_range') continue;
    if (!cond.range) {
      errors.push({
        code: 'DT_COMPLETENESS_SKIPPED',
        message: `Completeness check skipped for '${cond.name}': no domain range declared (use Values column e.g. "0..1000")`,
        severity: 'warning',
        location: { decisionTable: dt.name, condition: cond.name },
        suggestion: `Add a domain range to the conditions table, e.g. "0..1000" in the Values column`,
      });
      continue;
    }

    const domain: Interval = { low: cond.range.min, high: cond.range.max, lowInc: true, highInc: true };

    // Collect all intervals from rules for this condition
    const allIntervals: Interval[] = [];
    for (const rule of dt.rules) {
      const cell = rule.conditions.get(cond.name);
      if (!cell) {
        // No condition means wildcard — covers entire domain
        allIntervals.push(domain);
      } else {
        allIntervals.push(...cellToIntervals(cell, domain));
      }
    }

    const gaps = checkIntervalCoverage(allIntervals, domain, cond.type === 'int_range');
    for (const gap of gaps) {
      const lowBound = gap.lowInc ? '[' : '(';
      const highBound = gap.highInc ? ']' : ')';
      errors.push({
        code: 'DT_INCOMPLETE',
        message: `Numeric condition '${cond.name}' has uncovered range ${lowBound}${gap.low}, ${gap.high}${highBound}`,
        severity: 'error',
        location: { decisionTable: dt.name, condition: cond.name },
        suggestion: `Add a rule covering the range ${lowBound}${gap.low}, ${gap.high}${highBound}`,
      });
    }
  }

  return errors;
}

function checkCompleteness(dt: DecisionTableDef): VerificationError[] {
  const errors: VerificationError[] = [];

  if (dt.conditions.length === 0) return errors; // Already reported in structural

  const hasNumericConditions = dt.conditions.some(c => c.type === 'int_range' || c.type === 'decimal_range');
  const enumBoolConditions = dt.conditions.filter(c => c.type !== 'int_range' && c.type !== 'decimal_range');

  // Interval-based completeness for numeric conditions (per-axis projection)
  if (hasNumericConditions) {
    errors.push(...checkNumericCompleteness(dt));
  }

  // Skip cartesian enumeration if there are no enum/bool conditions
  if (enumBoolConditions.length === 0) return errors;

  // Calculate total combinations for enum/bool conditions only
  let totalCombinations = 1;
  for (const cond of enumBoolConditions) {
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
      message: `Completeness check skipped: ${totalCombinations} enum/bool combinations exceed limit of 4096`,
      severity: 'warning',
      location: { decisionTable: dt.name },
      suggestion: 'Consider simplifying conditions or using wildcards to reduce combination count',
    });
    return errors;
  }

  // For mixed tables (numeric + enum/bool), enumerate only the enum/bool axes
  // and check that for each enum/bool combination, at least one rule could fire
  // (numeric conditions are checked separately above via interval analysis)
  if (hasNumericConditions) {
    // Enumerate enum/bool combinations, check that at least one rule has matching enum/bool
    // cells (ignoring numeric conditions which are covered by interval checks)
    const enumCombinations = generateCombinations(enumBoolConditions);
    for (const combo of enumCombinations) {
      const anyRuleMatchesEnums = dt.rules.some(rule => {
        for (const cond of enumBoolConditions) {
          const cell = rule.conditions.get(cond.name);
          if (!cell) continue;
          const expectedValue = combo.get(cond.name);
          if (!cellMatches(cell, expectedValue || '')) return false;
        }
        return true;
      });

      if (!anyRuleMatchesEnums) {
        const comboDesc = [...combo.entries()].map(([k, v]) => `${k}=${v}`).join(', ');
        errors.push({
          code: 'DT_INCOMPLETE',
          message: `Missing coverage for enum/bool combination: ${comboDesc}`,
          severity: 'error',
          location: { decisionTable: dt.name },
          suggestion: `Add a rule to cover this condition combination`,
        });
      }
    }
  } else {
    // Pure enum/bool table — original cartesian completeness check
    const combinations = generateCombinations(dt.conditions);

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
 * Compute the set of guard names that test a DT output field against a value
 * the DT never produces. These guards are always false after the DT action fires.
 */
function computeDeadGuardNames(dt: DecisionTableDef, machine: MachineDef): Set<string> {
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
  const dead = new Set<string>();

  for (const guardDef of machine.guards) {
    const comparisons = collectFieldComparisons(guardDef.expression);
    for (const { field, op, value } of comparisons) {
      if (!outputFields.has(field)) continue;
      if (op !== 'eq') continue;
      const possible = outputDomain.get(field)!;
      if (!possible.has(value)) {
        dead.add(guardDef.name);
      }
    }
  }

  return dead;
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
 * BFS from initial state, optionally skipping transitions guarded by dead guards.
 * A non-negated transition guarded by a name in `deadGuards` is skipped (never fires).
 * A negated dead guard (!dead) is NOT skipped — negation of a dead guard is always true.
 */
function bfsReachableWithDeadGuards(machine: MachineDef, deadGuards: Set<string>): Set<string> {
  const initial = machine.states.find(s => s.isInitial);
  if (!initial) return new Set();

  const visited = new Set<string>();
  const queue = [initial.name];

  while (queue.length > 0) {
    const state = queue.shift()!;
    if (visited.has(state)) continue;
    visited.add(state);

    for (const t of machine.transitions) {
      if (t.source !== state) continue;
      // A non-negated dead guard means the transition can never fire
      if (t.guard && !t.guard.negated && deadGuards.has(t.guard.name)) continue;
      if (!visited.has(t.target)) queue.push(t.target);
    }
  }

  return visited;
}

/**
 * DT_UNREACHABLE_STATE: A state that is graph-reachable but only accessible via
 * transitions guarded by dead guards — it can never be entered given DT outputs.
 * Reported as a warning (structural reachability is preserved; the constraint is semantic).
 */
function checkDTDeadGuardReachability(dt: DecisionTableDef, machine: MachineDef): VerificationError[] {
  const deadGuards = computeDeadGuardNames(dt, machine);
  if (deadGuards.size === 0) return [];

  const plainReachable = bfsReachableWithDeadGuards(machine, new Set());
  const dtReachable = bfsReachableWithDeadGuards(machine, deadGuards);

  const errors: VerificationError[] = [];
  const deadList = [...deadGuards].join(', ');

  for (const state of machine.states) {
    if (plainReachable.has(state.name) && !dtReachable.has(state.name)) {
      errors.push({
        code: 'DT_UNREACHABLE_STATE',
        message: `State '${state.name}' is unreachable given '${dt.name}' output constraints — all entry paths are gated by dead guards (${deadList})`,
        severity: 'warning',
        location: { state: state.name, decisionTable: dt.name },
        suggestion: `Update '${dt.name}' to produce values that satisfy the guards leading to '${state.name}', or revise the guard expressions`,
      });
    }
  }

  return errors;
}

/**
 * Check DT integration with the machine: coverage gap, dead guards, and
 * DT-constrained reachability. Only runs when exactly one machine is present
 * and the DT is fully aligned. Multi-machine files are skipped (ambiguous ownership).
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
    errors.push(...checkDTDeadGuardReachability(dt, machine));
  }

  return errors;
}

/**
 * Compute the merged output domain across all aligned DTs in a single-machine file.
 * Returns a map from DT output field name → set of values the DT(s) can produce.
 * Used by the properties checker to prune guard-protected transitions that are
 * semantically impossible given DT output constraints.
 * Returns undefined if no aligned DTs are found.
 */
export function computeAlignedDTOutputDomain(file: OrcaFile): Map<string, Set<string>> | undefined {
  if (file.machines.length !== 1 || file.decisionTables.length === 0) return undefined;
  const machine = file.machines[0];
  const contextMap = new Map(machine.context.map(f => [f.name, f]));

  const domain = new Map<string, Set<string>>();

  for (const dt of file.decisionTables) {
    const allAligned = [...dt.conditions, ...dt.actions].every(item => contextMap.has(item.name));
    if (!allAligned) continue;

    for (const actionDef of dt.actions) {
      if (!domain.has(actionDef.name)) domain.set(actionDef.name, new Set());
      for (const rule of dt.rules) {
        const val = rule.actions.get(actionDef.name);
        if (val !== undefined) domain.get(actionDef.name)!.add(val);
      }
    }
  }

  return domain.size > 0 ? domain : undefined;
}
