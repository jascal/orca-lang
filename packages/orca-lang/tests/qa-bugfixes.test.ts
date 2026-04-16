import { describe, it, expect } from 'vitest';
import { parseMachine, parseMarkdown } from '../src/parser/markdown-parser.js';
import { checkStructural, analyzeMachine, checkReachability } from '../src/verifier/structural.js';
import { checkDeterminism, areExpressionsMutuallyExclusive } from '../src/verifier/determinism.js';
import { compileToXState } from '../src/compiler/xstate.js';
import {
  compileDecisionTableToTypeScript,
  compileDecisionTableToJSON,
} from '../src/compiler/dt-compiler.js';

// ============================================================
// M-7: areGuardsMutuallyExclusive requires ALL pairs exclusive
// ============================================================

describe('M-7: areGuardsMutuallyExclusive checks all pairs', () => {
  it('warns when guards are not all pairwise exclusive', () => {
    // Three guards where A↔B exclusive, B↔C exclusive, but A↔C overlap
    // ctx.x == 1 vs ctx.x == 2 (exclusive)
    // ctx.x == 2 vs ctx.x == 3 (exclusive)
    // ctx.x == 1 vs ctx.x == 3 (exclusive — all eq pairs on same var are exclusive)
    // Use a case where overlap actually occurs:
    // g1: ctx.x < 5, g2: ctx.x > 3, g3: ctx.x == 4
    // g1↔g3: not exclusive (x=4 satisfies both)
    const machine = parseMachine(`
# machine OverlappingGuards

## context

| Field | Type | Default |
|-------|------|---------|
| x     | int  | 0       |

## events

- ev

## guards

| Name | Expression |
|------|------------|
| low  | \`ctx.x < 5\` |
| mid  | \`ctx.x > 3\` |

## state s [initial]

## transitions

| Source | Event | Guard | Target |
|--------|-------|-------|--------|
| s      | ev    | low   | s      |
| s      | ev    | mid   | s      |
`);
    const result = checkDeterminism(machine);
    // low (ctx.x < 5) and mid (ctx.x > 3) overlap at x=4
    // Should warn about guard exhaustiveness
    expect(result.errors.some(e => e.code === 'GUARD_EXHAUSTIVENESS')).toBe(true);
  });

  it('passes when all guard pairs are truly exclusive', () => {
    const machine = parseMachine(`
# machine ExclusiveGuards

## context

| Field | Type | Default |
|-------|------|---------|
| x     | int  | 0       |

## events

- ev

## guards

| Name | Expression |
|------|------------|
| low  | \`ctx.x < 5\`  |
| high | \`ctx.x >= 5\` |

## state s [initial]

## transitions

| Source | Event | Guard | Target |
|--------|-------|-------|--------|
| s      | ev    | low   | s      |
| s      | ev    | high  | s      |
`);
    const result = checkDeterminism(machine);
    expect(result.errors.some(e => e.code === 'GUARD_EXHAUSTIVENESS')).toBe(false);
  });
});

// ============================================================
// M-8: Unresolved guards no longer silently pass
// ============================================================

describe('M-8: unresolved guards emit warning', () => {
  it('warns when guard name cannot be resolved', () => {
    const machine = parseMachine(`
# machine UnresolvedGuard

## context

| Field | Type | Default |
|-------|------|---------|
| x     | int  | 0       |

## events

- ev

## guards

| Name | Expression |
|------|------------|
| g1   | \`ctx.x == 1\` |

## state s [initial]

## transitions

| Source | Event | Guard | Target |
|--------|-------|-------|--------|
| s      | ev    | g1            | s      |
| s      | ev    | nonexistent   | s      |
`);
    const result = checkDeterminism(machine);
    // Should warn because 'nonexistent' can't be resolved
    expect(result.errors.some(e => e.code === 'GUARD_EXHAUSTIVENESS')).toBe(true);
  });
});

// ============================================================
// H-4: Reachability reports unreachable child states
// ============================================================

describe('H-4: reachability checks child states', () => {
  it('detects unreachable compound state and its children', () => {
    const machine = parseMachine(`
# machine UnreachableCompound

## context

| Field | Type |
|-------|------|
| x     | int  |

## events

- e1

## state start [initial]

## state island

### state sub1 [initial]

### state sub2

## transitions

| Source | Event | Target |
|--------|-------|--------|
| start  | e1    | start  |
`);
    const analysis = analyzeMachine(machine);
    const errors = checkReachability(analysis);
    // 'island' is unreachable, and so are its children island.sub1, island.sub2
    expect(errors.some(e => e.code === 'UNREACHABLE_STATE' && e.message!.includes('island'))).toBe(true);
    expect(errors.some(e => e.code === 'UNREACHABLE_STATE' && e.message!.includes('island.sub1'))).toBe(true);
    expect(errors.some(e => e.code === 'UNREACHABLE_STATE' && e.message!.includes('island.sub2'))).toBe(true);
  });

  it('reachable compound state children are not flagged', () => {
    const machine = parseMachine(`
# machine ReachableChildren

## context

| Field | Type |
|-------|------|
| x     | int  |

## events

- e1

## state parent [initial]

### state child1 [initial]

### state child2

## transitions

| Source | Event | Target |
|--------|-------|--------|
| child1 | e1   | child2 |
`);
    const analysis = analyzeMachine(machine);
    const errors = checkReachability(analysis);
    // All states reachable — parent is initial, children are reachable via parent
    expect(errors.filter(e => e.code === 'UNREACHABLE_STATE')).toHaveLength(0);
  });
});

// ============================================================
// M-1: responds: property validates 'within' bound
// ============================================================

describe('M-1: responds property rejects missing within', () => {
  it('throws when within is missing from responds property', () => {
    expect(() => parseMachine(`
# machine BadResponds

## context

| Field | Type |
|-------|------|
| x     | int  |

## events

- ev

## state idle [initial]

## state done [final]

## transitions

| Source | Event | Target |
|--------|-------|--------|
| idle   | ev    | done   |

## properties

- responds: done from idle within 5
`)).not.toThrow();

    // Missing 'within N' should throw
    expect(() => parseMachine(`
# machine BadResponds

## context

| Field | Type |
|-------|------|
| x     | int  |

## events

- ev

## state idle [initial]

## state done [final]

## transitions

| Source | Event | Target |
|--------|-------|--------|
| idle   | ev    | done   |

## properties

- responds: done from idle
`)).toThrow(/missing 'within N' bound/);
  });

  it('throws when within value is not a number', () => {
    expect(() => parseMachine(`
# machine BadResponds

## context

| Field | Type |
|-------|------|
| x     | int  |

## events

- ev

## state idle [initial]

## state done [final]

## transitions

| Source | Event | Target |
|--------|-------|--------|
| idle   | ev    | done   |

## properties

- responds: done from idle within abc
`)).toThrow(/not a number/);
  });
});

// ============================================================
// H-5: String compiler uses object guard syntax
// ============================================================

describe('H-5: string compiler emits object guard syntax', () => {
  it('emits guard: { type: ... } instead of string literal', () => {
    const machine = parseMachine(`
# machine GuardedMachine

## context

| Field | Type | Default |
|-------|------|---------|
| x     | int  | 0       |

## events

- ev

## guards

| Name | Expression |
|------|------------|
| g1   | \`ctx.x == 1\` |

## state s [initial]

## transitions

| Source | Event | Guard | Target |
|--------|-------|-------|--------|
| s      | ev    | g1    | s      |
| s      | ev    | !g1   | s      |
`);
    const output = compileToXState(machine);
    // Should use object syntax, not string
    expect(output).toContain("guard: { type: 'g1' }");
    expect(output).toContain("guard: { type: '!g1' }");
    expect(output).not.toMatch(/guard: 'g1'/);
  });
});

// ============================================================
// H-7: String compiler emits guards section
// ============================================================

describe('H-7: string compiler includes guards definitions', () => {
  it('emits guards section when guards are defined', () => {
    const machine = parseMachine(`
# machine WithGuards

## context

| Field | Type | Default |
|-------|------|---------|
| x     | int  | 0       |

## events

- ev

## guards

| Name | Expression |
|------|------------|
| is_ready | \`ctx.x > 0\` |

## state s [initial]

## transitions

| Source | Event | Guard | Target |
|--------|-------|-------|--------|
| s      | ev    | is_ready | s   |
`);
    const output = compileToXState(machine);
    expect(output).toContain('guards: {');
    expect(output).toContain("'is_ready'");
  });

  it('omits guards section when no guards defined', () => {
    const machine = parseMachine(`
# machine NoGuards

## context

| Field | Type | Default |
|-------|------|---------|
| x     | int  | 0       |

## events

- ev

## state s [initial]

## transitions

| Source | Event | Target |
|--------|-------|--------|
| s      | ev    | s      |
`);
    const output = compileToXState(machine);
    expect(output).not.toContain('guards: {');
  });
});

// ============================================================
// M-16: Numeric set conditions don't quote values
// ============================================================

describe('M-16: numeric set conditions use unquoted values', () => {
  it('generates unquoted numeric values for int_range set conditions', () => {
    const result = parseMarkdown(`# decision_table NumericSet

## conditions

| Name | Type | Values |
|------|------|--------|
| score | int_range | 0..100 |

## actions

| Name | Type | Values |
|------|------|--------|
| grade | enum | A, B, F |

## rules

| score | → grade |
|-------|---------|
| 90,95,100 | A |
| 80 | B |
`);
    const dt = result.file.decisionTables[0];
    const output = compileDecisionTableToTypeScript(dt);
    // Numeric values should NOT be quoted
    expect(output).toContain('input.score === 90');
    expect(output).not.toContain("input.score === '90'");
  });
});

// ============================================================
// L-5: JSON compile includes compare and range cells
// ============================================================

describe('L-5: JSON compile serializes compare and range cells', () => {
  it('includes compare cells in JSON output', () => {
    const result = parseMarkdown(`# decision_table RangeTest

## conditions

| Name | Type | Values |
|------|------|--------|
| score | int_range | 0..100 |

## actions

| Name | Type | Values |
|------|------|--------|
| tier | enum | low, high |

## rules

| score | → tier |
|-------|--------|
| >=80  | high   |
| 0..79 | low    |
`);
    const dt = result.file.decisionTables[0];
    const jsonStr = compileDecisionTableToJSON(dt);
    const json = JSON.parse(jsonStr);

    // compare cell (>=80) should be present
    expect(json.rules[0].conditions.score).toBe('>=80');
    // range cell (0..79) should be present
    expect(json.rules[1].conditions.score).toBe('0..79');
  });
});
