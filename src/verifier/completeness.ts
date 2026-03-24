import { MachineDef, Transition, StateDef } from '../parser/ast.js';
import { VerificationResult, VerificationError, analyzeMachine, flattenStates, FlattenedState } from './structural.js';

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

  // Flatten states for hierarchical handling
  const flattenedStates = flattenStates(machine.states);

  // Build a map of compound state name -> its child state names
  const compoundChildren = new Map<string, string[]>();
  for (const fs of flattenedStates) {
    if (fs.parentName) {
      if (!compoundChildren.has(fs.parentName)) {
        compoundChildren.set(fs.parentName, []);
      }
      compoundChildren.get(fs.parentName)!.push(fs.name);
    }
  }

  // Check every state handles every event
  for (const fs of flattenedStates) {
    // Skip child states - they're covered by parent compound state checks
    // (transitions on compound state fire from any child)
    if (fs.parentName) continue;

    // For compound states, we check if ANY child handles the event
    // For leaf states, we check directly
    const isHandledForEvent = (stateName: string, eventName: string): boolean => {
      // Check direct transitions from this state
      const directKey = `${stateName}+${eventName}`;
      if (transitionMap.has(directKey)) return true;

      // For compound states, also check if any child has a transition for this event
      const children = compoundChildren.get(stateName);
      if (children) {
        for (const child of children) {
          const childKey = `${child}+${eventName}`;
          if (transitionMap.has(childKey)) return true;
          // Recursively check grandchildren
          if (isHandledForEvent(child, eventName)) return true;
        }
      }
      return false;
    };

    const stateInfo = analysis.stateMap.get(fs.name);
    if (!stateInfo) continue;

    for (const event of machine.events) {
      const transitions = transitionMap.get(`${fs.name}+${event.name}`) || [];
      const isIgnored = stateInfo.eventsIgnored.has(event.name);
      const hasHandler = isHandledForEvent(fs.name, event.name);

      // Event is not handled and not ignored
      if (!hasHandler && !isIgnored && !fs.isFinal) {
        errors.push({
          code: 'INCOMPLETE_EVENT_HANDLING',
          message: `State '${fs.name}' does not handle event '${event.name}'`,
          severity: 'error',
          location: { state: fs.name, event: event.name },
          suggestion: `Add transition: ${fs.name} + ${event.name} -> <target> : <action>`,
        });
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
