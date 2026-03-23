import { MachineDef, Transition } from '../parser/ast.js';
import { VerificationResult, VerificationError, analyzeMachine } from './structural.js';

export function checkCompleteness(machine: MachineDef): VerificationResult {
  const analysis = analyzeMachine(machine);
  const errors: VerificationError[] = [];

  // Build a map of (state, event) -> transitions
  const transitionMap = new Map<string, Transition[]>();

  for (const transition of machine.transitions) {
    const key = `${transition.source}+${transition.event}`;
    if (!transitionMap.has(key)) {
      transitionMap.set(key, []);
    }
    transitionMap.get(key)!.push(transition);
  }

  // Check every state handles every event
  for (const state of machine.states) {
    const stateInfo = analysis.stateMap.get(state.name);
    if (!stateInfo) continue;

    for (const event of machine.events) {
      const key = `${state.name}+${event.name}`;
      const transitions = transitionMap.get(key) || [];
      const isIgnored = stateInfo.eventsIgnored.has(event.name);

      // Event is not handled and not ignored
      if (transitions.length === 0 && !isIgnored && !state.isFinal) {
        errors.push({
          code: 'INCOMPLETE_EVENT_HANDLING',
          message: `State '${state.name}' does not handle event '${event.name}'`,
          severity: 'error',
          location: { state: state.name, event: event.name },
          suggestion: `Add transition: ${state.name} + ${event.name} -> <target> : <action>`,
        });
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
