import { MachineDef, Transition, GuardRef, GuardDef, GuardExpression, ComparisonOp, VariableRef, ValueRef } from '../parser/ast.js';
import { VerificationResult, VerificationError } from './structural.js';

export function checkDeterminism(machine: MachineDef): VerificationResult {
  const errors: VerificationError[] = [];

  // Build guard lookup by name
  const guardDefMap = new Map<string, GuardDef>();
  for (const g of machine.guards) {
    guardDefMap.set(g.name, g);
  }

  // Build a map of (state, event) -> transitions with guards
  const transitionMap = new Map<string, Transition[]>();

  for (const transition of machine.transitions) {
    const key = `${transition.source}+${transition.event}`;
    if (!transitionMap.has(key)) {
      transitionMap.set(key, []);
    }
    transitionMap.get(key)!.push(transition);
  }

  // Check each (state, event) pair
  for (const [key, transitions] of transitionMap) {
    if (transitions.length <= 1) continue;

    // Multiple transitions for same state+event
    const guards = transitions.map(t => t.guard);
    const hasUnguarded = guards.some(g => !g);

    // If there are multiple unguarded transitions, that's always an error
    if (hasUnguarded && guards.filter(g => !g).length > 1) {
      const [stateName, eventName] = key.split('+');
      errors.push({
        code: 'NON_DETERMINISTIC',
        message: `State '${stateName}' has multiple unguarded transitions for event '${eventName}'`,
        severity: 'error',
        location: {
          state: stateName,
          event: eventName,
        },
        suggestion: 'Add guards to make transitions mutually exclusive',
      });
    }

    // Check mutual exclusivity of guards
    const guardedTransitions = transitions.filter(t => t.guard);
    if (guardedTransitions.length > 1) {
      const guardNames = guardedTransitions.map(t => {
        const g = t.guard!;
        return g.negated ? `!${g.name}` : g.name;
      });

      const mutuallyExclusive = areGuardsMutuallyExclusive(
        guardedTransitions.map(t => t.guard!),
        guardDefMap,
      );

      if (!mutuallyExclusive) {
        const [stateName, eventName] = key.split('+');
        errors.push({
          code: 'GUARD_EXHAUSTIVENESS',
          message: `State '${stateName}' transitions for event '${eventName}' may not be exhaustive: ${guardNames.join(', ')}`,
          severity: 'warning',
          location: { state: stateName, event: eventName },
          suggestion: 'Ensure guards cover all possible context values',
        });
      }
    }
  }

  return {
    valid: errors.filter(e => e.severity === 'error').length === 0,
    errors,
  };
}

/**
 * Check if a set of guard references are pairwise mutually exclusive.
 * Uses multiple strategies:
 * 1. Simple negation pairs (g and !g)
 * 2. Expression-level complementary analysis
 */
function areGuardsMutuallyExclusive(
  guardRefs: GuardRef[],
  guardDefs: Map<string, GuardDef>,
): boolean {
  // Strategy 1: Simple name-based negation pairs (g and !g)
  const hasSimpleNegationPair = guardRefs.some(g1 =>
    guardRefs.some(g2 => {
      if (g1 === g2) return false;
      return g1.name === g2.name && g1.negated !== g2.negated;
    })
  );
  if (hasSimpleNegationPair) return true;

  // Strategy 2: Resolve to expressions and check pairwise exclusivity
  const resolvedExprs = guardRefs.map(ref => resolveGuardExpression(ref, guardDefs));

  // If any guard couldn't be resolved, we can't verify — assume OK
  if (resolvedExprs.some(e => e === null)) return true;

  // Check all pairs are mutually exclusive
  for (let i = 0; i < resolvedExprs.length; i++) {
    for (let j = i + 1; j < resolvedExprs.length; j++) {
      if (areExpressionsMutuallyExclusive(resolvedExprs[i]!, resolvedExprs[j]!)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Resolve a GuardRef (name + negated flag) into its full GuardExpression.
 */
function resolveGuardExpression(
  ref: GuardRef,
  guardDefs: Map<string, GuardDef>,
): GuardExpression | null {
  const def = guardDefs.get(ref.name);
  if (!def) return null;

  if (ref.negated) {
    return { kind: 'not', expr: def.expression };
  }
  return def.expression;
}

/**
 * Check if two guard expressions are mutually exclusive (can never both be true).
 */
function areExpressionsMutuallyExclusive(a: GuardExpression, b: GuardExpression): boolean {
  // Unwrap negation: a and not(a) are exclusive
  const aNorm = unwrapNot(a);
  const bNorm = unwrapNot(b);

  // If one is the negation of the other (structurally equal after unwrapping)
  if (aNorm.negated !== bNorm.negated && expressionsEqual(aNorm.expr, bNorm.expr)) {
    return true;
  }

  // true vs false
  if (a.kind === 'true' && b.kind === 'false') return true;
  if (a.kind === 'false' && b.kind === 'true') return true;

  // Complementary comparisons on the same variable
  if (a.kind === 'compare' && b.kind === 'compare') {
    if (variablePathsEqual(a.left, b.left)) {
      return areComparisonsExclusive(a.op, a.right, b.op, b.right);
    }
  }

  // Complementary nullchecks on the same variable
  if (a.kind === 'nullcheck' && b.kind === 'nullcheck') {
    if (variablePathsEqual(a.expr, b.expr) && a.isNull !== b.isNull) {
      return true;
    }
  }

  // Compare vs nullcheck on same variable: ctx.x == value vs ctx.x is null
  if (a.kind === 'compare' && b.kind === 'nullcheck') {
    if (variablePathsEqual(a.left, b.expr) && b.isNull) {
      return true; // if ctx.x equals a concrete value, it's not null
    }
  }
  if (b.kind === 'compare' && a.kind === 'nullcheck') {
    if (variablePathsEqual(b.left, a.expr) && a.isNull) {
      return true;
    }
  }

  // not(E) vs E at expression level
  if (a.kind === 'not') {
    if (areExpressionsMutuallyExclusive(a.expr, b)) return false; // don't recurse infinitely
    if (expressionsEqual(a.expr, b)) return true;
  }
  if (b.kind === 'not') {
    if (expressionsEqual(b.expr, a)) return true;
  }

  return false;
}

interface UnwrappedExpr {
  expr: GuardExpression;
  negated: boolean;
}

/**
 * Unwrap layers of NOT to get the core expression and parity.
 */
function unwrapNot(expr: GuardExpression): UnwrappedExpr {
  let negated = false;
  let current = expr;
  while (current.kind === 'not') {
    negated = !negated;
    current = current.expr;
  }
  return { expr: current, negated };
}

/**
 * Check if two comparison operations on the same variable are mutually exclusive.
 */
function areComparisonsExclusive(
  op1: ComparisonOp, val1: ValueRef,
  op2: ComparisonOp, val2: ValueRef,
): boolean {
  // Different constant values with == are always exclusive
  if (op1 === 'eq' && op2 === 'eq') {
    return !valuesEqual(val1, val2);
  }

  // eq vs ne on same value are exclusive
  if ((op1 === 'eq' && op2 === 'ne') || (op1 === 'ne' && op2 === 'eq')) {
    if (valuesEqual(val1, val2)) return true;
  }

  // Complementary inequality pairs on same value: < vs >=, > vs <=, lt vs ge, gt vs le
  if (valuesEqual(val1, val2)) {
    const complementaryPairs: [ComparisonOp, ComparisonOp][] = [
      ['lt', 'ge'],
      ['ge', 'lt'],
      ['gt', 'le'],
      ['le', 'gt'],
    ];
    for (const [a, b] of complementaryPairs) {
      if (op1 === a && op2 === b) return true;
    }
  }

  // Numeric range exclusion: ctx.x < 3 vs ctx.x > 5 (always exclusive)
  // ctx.x < A vs ctx.x > B where A <= B
  if (val1.type === 'number' && val2.type === 'number') {
    const v1 = val1.value as number;
    const v2 = val2.value as number;

    // lt/le A vs gt/ge B where ranges don't overlap
    if ((op1 === 'lt' || op1 === 'le') && (op2 === 'gt' || op2 === 'ge')) {
      if (op1 === 'lt' && op2 === 'ge' && v1 <= v2) return true;
      if (op1 === 'lt' && op2 === 'gt' && v1 <= v2) return true;
      if (op1 === 'le' && op2 === 'gt' && v1 <= v2) return true;
      if (op1 === 'le' && op2 === 'ge' && v1 < v2) return true;
    }
    if ((op2 === 'lt' || op2 === 'le') && (op1 === 'gt' || op1 === 'ge')) {
      if (op2 === 'lt' && op1 === 'ge' && v2 <= v1) return true;
      if (op2 === 'lt' && op1 === 'gt' && v2 <= v1) return true;
      if (op2 === 'le' && op1 === 'gt' && v2 <= v1) return true;
      if (op2 === 'le' && op1 === 'ge' && v2 < v1) return true;
    }

    // eq vs lt/gt: ctx.x == 5 vs ctx.x < 3 (exclusive if 5 >= 3)
    if (op1 === 'eq' && (op2 === 'lt' && v1 >= v2)) return true;
    if (op1 === 'eq' && (op2 === 'le' && v1 > v2)) return true;
    if (op1 === 'eq' && (op2 === 'gt' && v1 <= v2)) return true;
    if (op1 === 'eq' && (op2 === 'ge' && v1 < v2)) return true;
    if (op2 === 'eq' && (op1 === 'lt' && v2 >= v1)) return true;
    if (op2 === 'eq' && (op1 === 'le' && v2 > v1)) return true;
    if (op2 === 'eq' && (op1 === 'gt' && v2 <= v1)) return true;
    if (op2 === 'eq' && (op1 === 'ge' && v2 < v1)) return true;
  }

  return false;
}

/**
 * Structural equality of two guard expressions.
 */
function expressionsEqual(a: GuardExpression, b: GuardExpression): boolean {
  if (a.kind !== b.kind) return false;

  switch (a.kind) {
    case 'true':
    case 'false':
      return true;
    case 'not':
      return expressionsEqual(a.expr, (b as typeof a).expr);
    case 'and':
    case 'or':
      return expressionsEqual(a.left, (b as typeof a).left) &&
             expressionsEqual(a.right, (b as typeof a).right);
    case 'compare': {
      const bc = b as typeof a;
      return a.op === bc.op &&
             variablePathsEqual(a.left, bc.left) &&
             valuesEqual(a.right, bc.right);
    }
    case 'nullcheck': {
      const bn = b as typeof a;
      return a.isNull === bn.isNull && variablePathsEqual(a.expr, bn.expr);
    }
    default:
      return false;
  }
}

function variablePathsEqual(a: VariableRef, b: VariableRef): boolean {
  if (a.path.length !== b.path.length) return false;
  return a.path.every((p, i) => p === b.path[i]);
}

function valuesEqual(a: ValueRef, b: ValueRef): boolean {
  return a.type === b.type && a.value === b.value;
}
