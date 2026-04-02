import { MachineDef, Property, ReachabilityProperty, PassesThroughProperty, RespondsProperty, InvariantProperty, GuardRef, GuardDef, GuardExpression } from '../parser/ast.js';
import { VerificationResult, VerificationError, MachineAnalysis, StateInfo } from './types.js';
import { analyzeMachine, flattenStates, FlattenedState } from './structural.js';
import { resolveGuardExpression, isExpressionStaticallyFalse } from './determinism.js';

const DEFAULT_MAX_STATES = 64;

/**
 * Check if a guard expression is statically false given DT output domain constraints.
 * A comparison `ctx.field == value` is false if the DT never outputs `value` for `field`.
 * Handles AND (false if either branch is domain-blocked) and OR (false only if both are).
 */
function isExpressionBlockedByDomain(
  expr: GuardExpression,
  domain: Map<string, Set<string>>
): boolean {
  if (expr.kind === 'compare' && expr.op === 'eq') {
    if (expr.left.path.length === 2 && expr.left.path[0] === 'ctx') {
      const field = expr.left.path[1];
      const value = String(expr.right.value);
      const possible = domain.get(field);
      if (possible !== undefined && !possible.has(value)) return true;
    }
  }
  if (expr.kind === 'and') {
    return isExpressionBlockedByDomain(expr.left, domain) ||
           isExpressionBlockedByDomain(expr.right, domain);
  }
  if (expr.kind === 'or') {
    return isExpressionBlockedByDomain(expr.left, domain) &&
           isExpressionBlockedByDomain(expr.right, domain);
  }
  return false;
}

/**
 * Check if a transition's guard is statically false (can never fire).
 * Used in guard-aware BFS to prune impossible transitions.
 * When dtOutputDomain is provided, also prunes guards that compare DT output
 * fields against values the DT never produces.
 */
function isTransitionStaticallyBlocked(
  transition: { guard?: GuardRef },
  guardDefs: Map<string, GuardDef>,
  dtOutputDomain?: Map<string, Set<string>>
): boolean {
  if (!transition.guard) return false; // No guard = always possible

  const resolved = resolveGuardExpression(transition.guard, guardDefs);
  if (!resolved) return false; // Can't resolve = assume possible

  if (isExpressionStaticallyFalse(resolved)) return true;

  if (dtOutputDomain && isExpressionBlockedByDomain(resolved, dtOutputDomain)) return true;

  return false;
}

/**
 * BFS from source state, returning reachable set and parent map for counterexample traces.
 * Supports guard-aware mode: skips transitions with statically false guards.
 * When dtOutputDomain is provided, also skips transitions whose guards are impossible
 * given the DT output domain constraints.
 */
function bfs(
  stateMap: Map<string, StateInfo>,
  source: string,
  options?: {
    excludeState?: string;
    maxDepth?: number;
    guardDefs?: Map<string, GuardDef>;
    dtOutputDomain?: Map<string, Set<string>>;
  }
): { reachable: Set<string>; parent: Map<string, { state: string; event: string; guard?: string }> } {
  const reachable = new Set<string>();
  const parent = new Map<string, { state: string; event: string; guard?: string }>();
  const queue: Array<{ name: string; depth: number }> = [{ name: source, depth: 0 }];

  reachable.add(source);

  while (queue.length > 0) {
    const { name, depth } = queue.shift()!;

    if (options?.maxDepth !== undefined && depth >= options.maxDepth) {
      continue;
    }

    const info = stateMap.get(name);
    if (!info) continue;

    for (const t of info.outgoing) {
      const target = t.target;

      // Skip excluded state
      if (options?.excludeState && target === options.excludeState) continue;

      // Guard-aware: skip transitions with statically false guards (including DT domain constraints)
      if (options?.guardDefs && isTransitionStaticallyBlocked(t, options.guardDefs, options.dtOutputDomain)) continue;

      if (!reachable.has(target)) {
        reachable.add(target);
        const guardName = t.guard ? (t.guard.negated ? `!${t.guard.name}` : t.guard.name) : undefined;
        parent.set(target, { state: name, event: t.event, guard: guardName });
        queue.push({ name: target, depth: depth + 1 });
      }
    }
  }

  return { reachable, parent };
}

/**
 * Reconstruct a path from source to target using the parent map.
 */
function reconstructPath(
  parent: Map<string, { state: string; event: string; guard?: string }>,
  source: string,
  target: string
): Array<{ state: string; event?: string; guard?: string }> {
  const path: Array<{ state: string; event?: string; guard?: string }> = [];
  let current = target;

  while (current !== source) {
    const prev = parent.get(current);
    if (!prev) break;
    path.unshift({ state: current, event: prev.event, guard: prev.guard });
    current = prev.state;
  }
  path.unshift({ state: source });

  return path;
}

/**
 * Format a path as a readable string, including guard conditions.
 */
function formatPath(path: Array<{ state: string; event?: string; guard?: string }>): string {
  return path
    .map((step, i) => {
      if (i === 0) return step.state;
      const guardStr = step.guard ? ` [${step.guard}]` : '';
      return `[${step.event}${guardStr}] -> ${step.state}`;
    })
    .join(' ');
}

/**
 * Check if any step in a path requires a guard condition.
 */
function pathHasGuards(path: Array<{ state: string; event?: string; guard?: string }>): boolean {
  return path.some(step => step.guard !== undefined);
}

/**
 * Resolve a state name to a flattened state name.
 * Supports both exact match and simple name match.
 */
function resolveStateName(
  name: string,
  flattenedStates: FlattenedState[]
): { resolved: string; error?: VerificationError } {
  // Exact match
  const exact = flattenedStates.find(fs => fs.name === name);
  if (exact) return { resolved: exact.name };

  // Simple name match
  const matches = flattenedStates.filter(fs => fs.simpleName === name && !fs.isRegion);
  if (matches.length === 1) return { resolved: matches[0].name };
  if (matches.length > 1) {
    return {
      resolved: '',
      error: {
        code: 'PROPERTY_AMBIGUOUS_STATE',
        message: `State name '${name}' is ambiguous — matches: ${matches.map(m => m.name).join(', ')}`,
        severity: 'error',
        suggestion: `Use the full dot-notation name to disambiguate`,
      },
    };
  }

  return {
    resolved: '',
    error: {
      code: 'PROPERTY_INVALID_STATE',
      message: `State '${name}' does not exist in this machine`,
      severity: 'error',
      suggestion: `Check the state name. Available states: ${flattenedStates.filter(fs => !fs.isRegion).map(fs => fs.name).join(', ')}`,
    },
  };
}

// --- Property checkers ---

function checkReachable(
  prop: ReachabilityProperty,
  analysis: MachineAnalysis,
  flattenedStates: FlattenedState[],
  guardDefs: Map<string, GuardDef>,
  dtOutputDomain?: Map<string, Set<string>>
): VerificationError[] {
  const errors: VerificationError[] = [];

  const fromRes = resolveStateName(prop.from, flattenedStates);
  if (fromRes.error) return [fromRes.error];
  const toRes = resolveStateName(prop.to, flattenedStates);
  if (toRes.error) return [toRes.error];

  const { reachable } = bfs(analysis.stateMap, fromRes.resolved, { guardDefs, dtOutputDomain });

  if (!reachable.has(toRes.resolved)) {
    errors.push({
      code: 'PROPERTY_REACHABILITY_FAIL',
      message: `Property 'reachable: ${prop.to} from ${prop.from}' violated — no path exists from '${fromRes.resolved}' to '${toRes.resolved}'`,
      severity: 'error',
      location: { state: fromRes.resolved },
      suggestion: `Add transitions that create a path from '${fromRes.resolved}' to '${toRes.resolved}'`,
    });
  }

  return errors;
}

function checkUnreachable(
  prop: ReachabilityProperty,
  analysis: MachineAnalysis,
  flattenedStates: FlattenedState[],
  guardDefs: Map<string, GuardDef>,
  dtOutputDomain?: Map<string, Set<string>>
): VerificationError[] {
  const errors: VerificationError[] = [];

  const fromRes = resolveStateName(prop.from, flattenedStates);
  if (fromRes.error) return [fromRes.error];
  const toRes = resolveStateName(prop.to, flattenedStates);
  if (toRes.error) return [toRes.error];

  const { reachable, parent } = bfs(analysis.stateMap, fromRes.resolved, { guardDefs, dtOutputDomain });

  if (reachable.has(toRes.resolved)) {
    const path = reconstructPath(parent, fromRes.resolved, toRes.resolved);
    const hasGuards = pathHasGuards(path);
    const guardNote = hasGuards
      ? ' Note: this path requires guard conditions — it may be prevented at runtime by guards.'
      : '';
    errors.push({
      code: 'PROPERTY_EXCLUSION_FAIL',
      message: `Property 'unreachable: ${prop.to} from ${prop.from}' violated — path exists: ${formatPath(path)}${guardNote}`,
      severity: 'error',
      location: { state: fromRes.resolved },
      suggestion: `Remove transitions that allow reaching '${toRes.resolved}' from '${fromRes.resolved}', or remove this property if the path is intentional.`,
    });
  }

  return errors;
}

function checkPassesThrough(
  prop: PassesThroughProperty,
  analysis: MachineAnalysis,
  flattenedStates: FlattenedState[],
  guardDefs: Map<string, GuardDef>,
  dtOutputDomain?: Map<string, Set<string>>
): VerificationError[] {
  const errors: VerificationError[] = [];

  const fromRes = resolveStateName(prop.from, flattenedStates);
  if (fromRes.error) return [fromRes.error];
  const toRes = resolveStateName(prop.to, flattenedStates);
  if (toRes.error) return [toRes.error];
  const throughRes = resolveStateName(prop.through, flattenedStates);
  if (throughRes.error) return [throughRes.error];

  // First check: is target reachable from source at all?
  const { reachable: fullReachable } = bfs(analysis.stateMap, fromRes.resolved, { guardDefs, dtOutputDomain });
  if (!fullReachable.has(toRes.resolved)) {
    errors.push({
      code: 'PROPERTY_PATH_FAIL',
      message: `Property 'passes_through: ${prop.through} for ${prop.from} -> ${prop.to}' — '${toRes.resolved}' is not reachable from '${fromRes.resolved}' at all`,
      severity: 'error',
      location: { state: fromRes.resolved },
      suggestion: `Ensure '${toRes.resolved}' is reachable from '${fromRes.resolved}' before adding path constraints`,
    });
    return errors;
  }

  // Core check: remove the intermediate state and see if target is still reachable
  const { reachable: withoutThrough, parent } = bfs(analysis.stateMap, fromRes.resolved, {
    excludeState: throughRes.resolved,
    guardDefs,
    dtOutputDomain,
  });

  if (withoutThrough.has(toRes.resolved)) {
    const path = reconstructPath(parent, fromRes.resolved, toRes.resolved);
    errors.push({
      code: 'PROPERTY_PATH_FAIL',
      message: `Property 'passes_through: ${prop.through} for ${prop.from} -> ${prop.to}' violated — path bypassing '${throughRes.resolved}': ${formatPath(path)}`,
      severity: 'error',
      location: { state: fromRes.resolved },
      suggestion: `Ensure all transitions from '${fromRes.resolved}' to '${toRes.resolved}' must pass through '${throughRes.resolved}'. Note: this check ignores guard conditions.`,
    });
  }

  return errors;
}

function checkLive(
  analysis: MachineAnalysis,
  flattenedStates: FlattenedState[],
  guardDefs: Map<string, GuardDef>,
  dtOutputDomain?: Map<string, Set<string>>
): VerificationError[] {
  const errors: VerificationError[] = [];

  if (!analysis.initialState) return errors;

  // Find all reachable states from initial
  const { reachable: reachableFromInitial } = bfs(analysis.stateMap, analysis.initialState.name, { guardDefs, dtOutputDomain });

  // Find all final state names
  const finalStateNames = new Set(analysis.finalStates.map(s => s.name));

  // For each reachable non-final leaf state, check if some final state is reachable
  for (const stateName of reachableFromInitial) {
    if (finalStateNames.has(stateName)) continue;

    // Skip compound/parallel/region states — liveness is about leaf states
    const fs = flattenedStates.find(f => f.name === stateName);
    if (fs && (fs.isCompound || fs.isRegion)) continue;

    const { reachable: reachableFromState } = bfs(analysis.stateMap, stateName, { guardDefs, dtOutputDomain });

    let canReachFinal = false;
    for (const finalName of finalStateNames) {
      if (reachableFromState.has(finalName)) {
        canReachFinal = true;
        break;
      }
    }

    if (!canReachFinal) {
      errors.push({
        code: 'PROPERTY_LIVENESS_FAIL',
        message: `Property 'live' violated — state '${stateName}' cannot reach any final state`,
        severity: 'error',
        location: { state: stateName },
        suggestion: `Add transitions from '${stateName}' that lead to a final state, or mark '${stateName}' as [final]`,
      });
    }
  }

  return errors;
}

function checkResponds(
  prop: RespondsProperty,
  analysis: MachineAnalysis,
  flattenedStates: FlattenedState[],
  guardDefs: Map<string, GuardDef>,
  dtOutputDomain?: Map<string, Set<string>>
): VerificationError[] {
  const errors: VerificationError[] = [];

  const fromRes = resolveStateName(prop.from, flattenedStates);
  if (fromRes.error) return [fromRes.error];
  const toRes = resolveStateName(prop.to, flattenedStates);
  if (toRes.error) return [toRes.error];

  const { reachable } = bfs(analysis.stateMap, fromRes.resolved, {
    maxDepth: prop.within,
    guardDefs,
    dtOutputDomain,
  });

  if (!reachable.has(toRes.resolved)) {
    // Check if it's reachable at all (just beyond the bound)
    const { reachable: unbounded } = bfs(analysis.stateMap, fromRes.resolved, { guardDefs, dtOutputDomain });
    const reachableButBeyondBound = unbounded.has(toRes.resolved);

    const suffix = reachableButBeyondBound
      ? ` (reachable beyond ${prop.within} transitions — increase the bound or shorten the path)`
      : ` (not reachable at all from '${fromRes.resolved}')`;

    errors.push({
      code: 'PROPERTY_RESPONSE_FAIL',
      message: `Property 'responds: ${prop.to} from ${prop.from} within ${prop.within}' violated — '${toRes.resolved}' not reachable within ${prop.within} transitions${suffix}`,
      severity: 'error',
      location: { state: fromRes.resolved },
      suggestion: `Shorten the path from '${fromRes.resolved}' to '${toRes.resolved}' or increase the bound`,
    });
  }

  return errors;
}

function checkInvariant(
  prop: InvariantProperty,
  machine: MachineDef,
  flattenedStates: FlattenedState[]
): VerificationError[] {
  const errors: VerificationError[] = [];

  // If a specific state is referenced, validate it exists
  if (prop.inState) {
    const stateRes = resolveStateName(prop.inState, flattenedStates);
    if (stateRes.error) return [stateRes.error];
  }

  // Validate that the invariant expression references declared context fields
  const contextFieldNames = new Set(machine.context.map(f => f.name));
  const undeclaredFields = findUndeclaredFields(prop.expression, contextFieldNames);

  for (const field of undeclaredFields) {
    errors.push({
      code: 'PROPERTY_INVARIANT_INVALID',
      message: `Invariant references undeclared context field '${field}'`,
      severity: 'error',
      suggestion: `Declare '${field}' in the context block or fix the field name`,
    });
  }

  if (undeclaredFields.length === 0) {
    // Advisory warning — topology-level check cannot prove context invariants
    const stateDesc = prop.inState ? ` in state '${prop.inState}'` : '';
    errors.push({
      code: 'PROPERTY_INVARIANT_ADVISORY',
      message: `Invariant${stateDesc} is syntactically valid but cannot be fully verified at topology level — requires runtime trace simulation`,
      severity: 'warning',
      suggestion: `This invariant will be checked during runtime verification when action implementations are available`,
    });
  }

  return errors;
}

/**
 * Find context field references in a guard expression that are not declared.
 */
function findUndeclaredFields(expr: import('../parser/ast.js').GuardExpression, declared: Set<string>): string[] {
  const undeclared: string[] = [];

  function walk(e: import('../parser/ast.js').GuardExpression): void {
    switch (e.kind) {
      case 'true':
      case 'false':
        break;
      case 'not':
        walk(e.expr);
        break;
      case 'and':
      case 'or':
        walk(e.left);
        walk(e.right);
        break;
      case 'compare': {
        // Check variable path — first segment after 'ctx' is the field name
        const path = e.left.path;
        if (path.length >= 2 && path[0] === 'ctx') {
          if (!declared.has(path[1])) {
            undeclared.push(path[1]);
          }
        }
        break;
      }
      case 'nullcheck': {
        const path = e.expr.path;
        if (path.length >= 2 && path[0] === 'ctx') {
          if (!declared.has(path[1])) {
            undeclared.push(path[1]);
          }
        }
        break;
      }
    }
  }

  walk(expr);
  return [...new Set(undeclared)];
}

// --- Size limit check ---

function checkMachineSize(
  flattenedStates: FlattenedState[],
  maxStates: number
): VerificationError[] {
  const leafCount = flattenedStates.filter(fs => !fs.isRegion).length;
  if (leafCount > maxStates) {
    return [{
      code: 'MACHINE_TOO_LARGE',
      message: `Machine has ${leafCount} states (limit: ${maxStates}). Decompose into hierarchical states or separate machines communicating via events.`,
      severity: 'error',
      suggestion: `Split the machine into smaller composed machines. Each machine should stay under ${maxStates} states for verifiable complexity.`,
    }];
  }
  return [];
}

// --- Main entry point ---

export function checkProperties(
  machine: MachineDef,
  options?: {
    maxStates?: number;
    /** DT output domain from co-located aligned decision tables. When provided,
     *  the guard-aware BFS will prune transitions whose guards compare DT output
     *  fields against values the DT never produces, giving more precise results. */
    dtOutputDomain?: Map<string, Set<string>>;
  }
): VerificationResult {
  const maxStates = options?.maxStates ?? DEFAULT_MAX_STATES;
  const flattenedStates = flattenStates(machine.states);
  const errors: VerificationError[] = [];

  // Size limit check (always runs, even without properties block)
  errors.push(...checkMachineSize(flattenedStates, maxStates));
  if (errors.some(e => e.severity === 'error')) {
    return { valid: false, errors };
  }

  // If no properties defined, pass
  if (!machine.properties || machine.properties.length === 0) {
    return { valid: true, errors };
  }

  const analysis = analyzeMachine(machine);
  const dtOutputDomain = options?.dtOutputDomain;

  // Build guard definition map for guard-aware BFS
  const guardDefs = new Map<string, GuardDef>();
  for (const g of machine.guards) {
    guardDefs.set(g.name, g);
  }

  for (const prop of machine.properties) {
    switch (prop.kind) {
      case 'reachable':
        errors.push(...checkReachable(prop, analysis, flattenedStates, guardDefs, dtOutputDomain));
        break;
      case 'unreachable':
        errors.push(...checkUnreachable(prop, analysis, flattenedStates, guardDefs, dtOutputDomain));
        break;
      case 'passes_through':
        errors.push(...checkPassesThrough(prop, analysis, flattenedStates, guardDefs, dtOutputDomain));
        break;
      case 'live':
        errors.push(...checkLive(analysis, flattenedStates, guardDefs, dtOutputDomain));
        break;
      case 'responds':
        errors.push(...checkResponds(prop, analysis, flattenedStates, guardDefs, dtOutputDomain));
        break;
      case 'invariant':
        errors.push(...checkInvariant(prop, machine, flattenedStates));
        break;
    }
  }

  return {
    valid: errors.filter(e => e.severity === 'error').length === 0,
    errors,
  };
}
