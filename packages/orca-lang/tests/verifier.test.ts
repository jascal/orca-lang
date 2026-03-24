import { describe, it, expect } from 'vitest';
import { tokenize } from '../src/parser/lexer.js';
import { parse } from '../src/parser/parser.js';
import { checkStructural } from '../src/verifier/structural.js';
import { checkCompleteness } from '../src/verifier/completeness.js';
import { checkDeterminism } from '../src/verifier/determinism.js';

function parseMachine(source: string) {
  return parse(tokenize(source)).machine;
}

describe('Structural Verifier', () => {
  it('passes for valid machine', () => {
    const machine = parseMachine(`
machine Valid
context { value: int }
events { tick }
state s1 [initial] {}
state s2 [final] {}
transitions {
  s1 + tick -> s2 : _
}
`);
    const result = checkStructural(machine);
    expect(result.valid).toBe(true);
  });

  it('detects unreachable state', () => {
    const machine = parseMachine(`
machine Broken
context {}
events { tick }
state s1 [initial] {}
state s2 {}
state s3 {}
transitions {
  s1 + tick -> s2 : _
}
`);
    const result = checkStructural(machine);
    // s3 is unreachable - no transitions lead to it
    expect(result.errors.some(e => e.code === 'UNREACHABLE_STATE')).toBe(true);
  });

  it('detects deadlock state', () => {
    const machine = parseMachine(`
machine Broken
context {}
events { tick }
state s1 [initial] {}
state s2 {}
transitions {}
`);
    const result = checkStructural(machine);
    expect(result.errors.some(e => e.code === 'DEADLOCK')).toBe(true);
  });

  it('detects final state with outgoing', () => {
    const machine = parseMachine(`
machine Broken
context {}
events { tick }
state s1 [initial] {}
state s2 [final] {}
transitions {
  s1 + tick -> s2 : _
  s2 + tick -> s1 : _
}
`);
    const result = checkStructural(machine);
    expect(result.errors.some(e => e.code === 'FINAL_STATE_OUTGOING')).toBe(true);
  });
});

describe('Completeness Verifier', () => {
  it('passes when all events handled', () => {
    const machine = parseMachine(`
machine Complete
context {}
events { start, stop }
state s1 [initial] {}
transitions {
  s1 + start -> s1 : _
  s1 + stop -> s1 : _
}
`);
    const result = checkCompleteness(machine);
    expect(result.valid).toBe(true);
  });

  it('detects unhandled event', () => {
    const machine = parseMachine(`
machine Incomplete
context {}
events { start, stop }
state s1 [initial] {}
transitions {
  s1 + start -> s1 : _
}
`);
    const result = checkCompleteness(machine);
    expect(result.errors.some(e => e.code === 'INCOMPLETE_EVENT_HANDLING')).toBe(true);
  });
});

describe('Determinism Verifier', () => {
  it('passes for single transition per event', () => {
    const machine = parseMachine(`
machine Deterministic
context {}
events { ev }
guards { g1: true }
state s [initial] {}
transitions {
  s + ev [g1] -> s : _
}
`);
    const result = checkDeterminism(machine);
    expect(result.valid).toBe(true);
  });
});
