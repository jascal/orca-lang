import { MachineDef, Transition } from '../parser/ast.js';
import { VerificationResult, VerificationError, analyzeMachine } from './structural.js';

export function checkDeterminism(machine: MachineDef): VerificationResult {
  const errors: VerificationError[] = [];

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

    // If there are unguarded transitions mixed with guarded ones, that's an issue
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

      // Simple check: if we have both `g` and `!g`, they are mutually exclusive
      const hasNegationPair = guardedTransitions.some(t1 =>
        guardedTransitions.some(t2 => {
          if (t1 === t2) return false;
          const g1 = t1.guard!;
          const g2 = t2.guard!;
          return g1.name === g2.name && g1.negated !== g2.negated;
        })
      );

      if (!hasNegationPair) {
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
