import { describe, it, expect } from 'vitest';
import { parseMarkdown } from '../src/parser/markdown-parser.js';
import { checkStructural } from '../src/verifier/structural.js';
import { checkCompleteness } from '../src/verifier/completeness.js';
import { checkDeterminism } from '../src/verifier/determinism.js';

function parseMachine(source: string) {
  return parseMarkdown(source).machine;
}

describe('Structural Verifier', () => {
  it('passes for valid machine', () => {
    const machine = parseMachine(`
# machine Valid

## context

| Field | Type |
|-------|------|
| value | int |

## events

- tick

## state s1 [initial]
> State 1

## state s2 [final]
> State 2

## transitions

| Source | Event | Target |
|--------|-------|--------|
| s1     | tick  | s2     |
`);
    const result = checkStructural(machine);
    expect(result.valid).toBe(true);
  });

  it('detects unreachable state', () => {
    const machine = parseMachine(`
# machine Broken

## context

| Field | Type |
|-------|------|
|       |      |

## events

- tick

## state s1 [initial]
> State 1

## state s2
> State 2

## state s3
> State 3

## transitions

| Source | Event | Target |
|--------|-------|--------|
| s1     | tick  | s2     |
`);
    const result = checkStructural(machine);
    // s3 is unreachable - no transitions lead to it
    expect(result.errors.some(e => e.code === 'UNREACHABLE_STATE')).toBe(true);
  });

  it('detects deadlock state', () => {
    const machine = parseMachine(`
# machine Broken

## context

| Field | Type |
|-------|------|
|       |      |

## events

- tick

## state s1 [initial]
> State 1

## state s2
> State 2

## transitions

| Source | Event | Target |
|--------|-------|--------|
|        |       |        |
`);
    const result = checkStructural(machine);
    expect(result.errors.some(e => e.code === 'DEADLOCK')).toBe(true);
  });

  it('detects final state with outgoing', () => {
    const machine = parseMachine(`
# machine Broken

## context

| Field | Type |
|-------|------|
|       |      |

## events

- tick

## state s1 [initial]
> State 1

## state s2 [final]
> State 2

## transitions

| Source | Event | Target |
|--------|-------|--------|
| s1     | tick  | s2     |
| s2     | tick  | s1     |
`);
    const result = checkStructural(machine);
    expect(result.errors.some(e => e.code === 'FINAL_STATE_OUTGOING')).toBe(true);
  });
});

describe('Completeness Verifier', () => {
  it('passes when all events handled', () => {
    const machine = parseMachine(`
# machine Complete

## context

| Field | Type |
|-------|------|
|       |      |

## events

- start
- stop

## state s1 [initial]
> State 1

## transitions

| Source | Event | Target |
|--------|-------|--------|
| s1     | start | s1     |
| s1     | stop  | s1     |
`);
    const result = checkCompleteness(machine);
    expect(result.valid).toBe(true);
  });

  it('detects unhandled event', () => {
    const machine = parseMachine(`
# machine Incomplete

## context

| Field | Type |
|-------|------|
|       |      |

## events

- start
- stop

## state s1 [initial]
> State 1

## transitions

| Source | Event | Target |
|--------|-------|--------|
| s1     | start | s1     |
`);
    const result = checkCompleteness(machine);
    expect(result.errors.some(e => e.code === 'INCOMPLETE_EVENT_HANDLING')).toBe(true);
  });
});

describe('Determinism Verifier', () => {
  it('passes for single transition per event', () => {
    const machine = parseMachine(`
# machine Deterministic

## context

| Field | Type |
|-------|------|
|       |      |

## events

- ev

## guards

| Name | Expression |
|------|------------|
| g1   | \`true\`   |

## state s [initial]
> State s

## transitions

| Source | Event | Guard | Target |
|--------|-------|-------|--------|
| s      | ev    | g1    | s      |
`);
    const result = checkDeterminism(machine);
    expect(result.valid).toBe(true);
  });

  it('passes for simple negation pair (g and !g)', () => {
    const machine = parseMachine(`
# machine NegPair

## context

| Field | Type |
|-------|------|
| x     | int  |

## events

- ev

## guards

| Name  | Expression       |
|-------|------------------|
| ready | \`ctx.x > 0\`   |

## state s [initial]
> State s

## state a
> State a

## state b
> State b

## transitions

| Source | Event | Guard | Target |
|--------|-------|-------|--------|
| s      | ev    | ready | a      |
| s      | ev    | !ready| b      |
`);
    const result = checkDeterminism(machine);
    expect(result.valid).toBe(true);
    expect(result.errors.filter(e => e.code === 'GUARD_EXHAUSTIVENESS')).toHaveLength(0);
  });

  it('passes for complementary comparisons (< and >=)', () => {
    const machine = parseMachine(`
# machine CompCompare

## context

| Field   | Type | Default |
|---------|------|---------|
| retries | int  | 0       |

## events

- ev

## guards

| Name       | Expression           |
|------------|----------------------|
| can_retry  | \`ctx.retries < 3\`  |
| max_retries| \`ctx.retries >= 3\` |

## state s [initial]
> State s

## state retry
> Retry state

## state fail
> Fail state

## transitions

| Source | Event | Guard      | Target |
|--------|-------|------------|--------|
| s      | ev    | can_retry  | retry  |
| s      | ev    | max_retries| fail   |
`);
    const result = checkDeterminism(machine);
    expect(result.valid).toBe(true);
    expect(result.errors.filter(e => e.code === 'GUARD_EXHAUSTIVENESS')).toHaveLength(0);
  });

  it('passes for same-variable different-value eq comparisons', () => {
    const machine = parseMachine(`
# machine EnumGuards

## context

| Field  | Type | Default |
|--------|------|---------|
| status | int  | 1       |

## events

- ev

## guards

| Name  | Expression          |
|-------|---------------------|
| is_one| \`ctx.status = 1\`  |
| is_two| \`ctx.status = 2\`  |

## state s [initial]
> State s

## state a
> State a

## state b
> State b

## transitions

| Source | Event | Guard   | Target |
|--------|-------|---------|--------|
| s      | ev    | is_one  | a      |
| s      | ev    | is_two  | b      |
`);
    const result = checkDeterminism(machine);
    expect(result.valid).toBe(true);
    expect(result.errors.filter(e => e.code === 'GUARD_EXHAUSTIVENESS')).toHaveLength(0);
  });

  it('passes for expression-level negation (g and !g via negated ref)', () => {
    const machine = parseMachine(`
# machine ExprNeg

## context

| Field | Type | Default |
|-------|------|---------|
| x     | int  | 0       |

## events

- ev

## guards

| Name  | Expression |
|-------|------------|
| ready | \`true\`   |

## state s [initial]
> State s

## state a
> State a

## state b
> State b

## transitions

| Source | Event | Guard | Target |
|--------|-------|-------|--------|
| s      | ev    | ready | a      |
| s      | ev    | !ready| b      |
`);
    const result = checkDeterminism(machine);
    expect(result.valid).toBe(true);
    expect(result.errors.filter(e => e.code === 'GUARD_EXHAUSTIVENESS')).toHaveLength(0);
  });

  it('warns for non-exclusive guards with different variables', () => {
    const machine = parseMachine(`
# machine NonExcl

## context

| Field | Type | Default |
|-------|------|---------|
| x     | int  | 0       |
| y     | int  | 0       |

## events

- ev

## guards

| Name | Expression        |
|------|------------------|
| g1   | \`ctx.x > 0\`   |
| g2   | \`ctx.y > 0\`   |

## state s [initial]
> State s

## state a
> State a

## state b
> State b

## transitions

| Source | Event | Guard | Target |
|--------|-------|-------|--------|
| s      | ev    | g1    | a      |
| s      | ev    | g2    | b      |
`);
    const result = checkDeterminism(machine);
    expect(result.errors.some(e => e.code === 'GUARD_EXHAUSTIVENESS')).toBe(true);
  });

  it('detects multiple unguarded transitions as error', () => {
    const machine = parseMachine(`
# machine MultiUnguarded

## context

| Field | Type |
|-------|------|
|       |      |

## events

- ev

## state s [initial]
> State s

## state a
> State a

## state b
> State b

## transitions

| Source | Event | Target |
|--------|-------|--------|
| s      | ev    | a      |
| s      | ev    | b      |
`);
    const result = checkDeterminism(machine);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'NON_DETERMINISTIC')).toBe(true);
  });

  it('passes for complementary gt/le on same value', () => {
    const machine = parseMachine(`
# machine GtLe

## context

| Field | Type | Default |
|-------|------|---------|
| score | int  | 0       |

## events

- ev

## guards

| Name | Expression            |
|------|-----------------------|
| high | \`ctx.score > 100\`  |
| low  | \`ctx.score <= 100\`  |

## state s [initial]
> State s

## state a
> State a

## state b
> State b

## transitions

| Source | Event | Guard | Target |
|--------|-------|-------|--------|
| s      | ev    | high  | a      |
| s      | ev    | low   | b      |
`);
    const result = checkDeterminism(machine);
    expect(result.valid).toBe(true);
    expect(result.errors.filter(e => e.code === 'GUARD_EXHAUSTIVENESS')).toHaveLength(0);
  });

  it('passes for non-overlapping numeric ranges', () => {
    const machine = parseMachine(`
# machine Ranges

## context

| Field | Type | Default |
|-------|------|---------|
| temp  | int  | 50      |

## events

- ev

## guards

| Name | Expression          |
|------|---------------------|
| cold | \`ctx.temp < 30\`  |
| hot  | \`ctx.temp > 80\`  |

## state s [initial]
> State s

## state a
> State a

## state b
> State b

## transitions

| Source | Event | Guard | Target |
|--------|-------|-------|--------|
| s      | ev    | cold  | a      |
| s      | ev    | hot   | b      |
`);
    const result = checkDeterminism(machine);
    expect(result.valid).toBe(true);
    expect(result.errors.filter(e => e.code === 'GUARD_EXHAUSTIVENESS')).toHaveLength(0);
  });
});
