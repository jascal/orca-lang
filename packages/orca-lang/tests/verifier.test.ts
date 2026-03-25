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

  it('passes for simple negation pair (g and !g)', () => {
    const machine = parseMachine(`
machine NegPair
context { x: int }
events { ev }
guards { ready: ctx.x > 0 }
state s [initial] {}
state a {}
state b {}
transitions {
  s + ev [ready] -> a : _
  s + ev [!ready] -> b : _
}
`);
    const result = checkDeterminism(machine);
    expect(result.valid).toBe(true);
    expect(result.errors.filter(e => e.code === 'GUARD_EXHAUSTIVENESS')).toHaveLength(0);
  });

  it('passes for complementary comparisons (< and >=)', () => {
    const machine = parseMachine(`
machine CompCompare
context { retries: int = 0 }
events { ev }
guards {
  can_retry: ctx.retries < 3
  max_retries: ctx.retries >= 3
}
state s [initial] {}
state retry {}
state fail {}
transitions {
  s + ev [can_retry] -> retry : _
  s + ev [max_retries] -> fail : _
}
`);
    const result = checkDeterminism(machine);
    expect(result.valid).toBe(true);
    expect(result.errors.filter(e => e.code === 'GUARD_EXHAUSTIVENESS')).toHaveLength(0);
  });

  it('passes for same-variable different-value eq comparisons', () => {
    const machine = parseMachine(`
machine EnumGuards
context { status: int = 1 }
events { ev }
guards {
  is_one: ctx.status = 1
  is_two: ctx.status = 2
}
state s [initial] {}
state a {}
state b {}
transitions {
  s + ev [is_one] -> a : _
  s + ev [is_two] -> b : _
}
`);
    const result = checkDeterminism(machine);
    expect(result.valid).toBe(true);
    expect(result.errors.filter(e => e.code === 'GUARD_EXHAUSTIVENESS')).toHaveLength(0);
  });

  it('passes for expression-level negation (g and !g via negated ref)', () => {
    const machine = parseMachine(`
machine ExprNeg
context { x: int = 0 }
events { ev }
guards {
  ready: true
}
state s [initial] {}
state a {}
state b {}
transitions {
  s + ev [ready] -> a : _
  s + ev [!ready] -> b : _
}
`);
    const result = checkDeterminism(machine);
    expect(result.valid).toBe(true);
    expect(result.errors.filter(e => e.code === 'GUARD_EXHAUSTIVENESS')).toHaveLength(0);
  });

  it('warns for non-exclusive guards with different variables', () => {
    const machine = parseMachine(`
machine NonExcl
context { x: int = 0, y: int = 0 }
events { ev }
guards {
  g1: ctx.x > 0
  g2: ctx.y > 0
}
state s [initial] {}
state a {}
state b {}
transitions {
  s + ev [g1] -> a : _
  s + ev [g2] -> b : _
}
`);
    const result = checkDeterminism(machine);
    expect(result.errors.some(e => e.code === 'GUARD_EXHAUSTIVENESS')).toBe(true);
  });

  it('detects multiple unguarded transitions as error', () => {
    const machine = parseMachine(`
machine MultiUnguarded
context {}
events { ev }
state s [initial] {}
state a {}
state b {}
transitions {
  s + ev -> a : _
  s + ev -> b : _
}
`);
    const result = checkDeterminism(machine);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'NON_DETERMINISTIC')).toBe(true);
  });

  it('passes for complementary gt/le on same value', () => {
    const machine = parseMachine(`
machine GtLe
context { score: int = 0 }
events { ev }
guards {
  high: ctx.score > 100
  low: ctx.score <= 100
}
state s [initial] {}
state a {}
state b {}
transitions {
  s + ev [high] -> a : _
  s + ev [low] -> b : _
}
`);
    const result = checkDeterminism(machine);
    expect(result.valid).toBe(true);
    expect(result.errors.filter(e => e.code === 'GUARD_EXHAUSTIVENESS')).toHaveLength(0);
  });

  it('passes for non-overlapping numeric ranges', () => {
    const machine = parseMachine(`
machine Ranges
context { temp: int = 50 }
events { ev }
guards {
  cold: ctx.temp < 30
  hot: ctx.temp > 80
}
state s [initial] {}
state a {}
state b {}
transitions {
  s + ev [cold] -> a : _
  s + ev [hot] -> b : _
}
`);
    const result = checkDeterminism(machine);
    expect(result.valid).toBe(true);
    expect(result.errors.filter(e => e.code === 'GUARD_EXHAUSTIVENESS')).toHaveLength(0);
  });
});
