import { describe, it, expect } from 'vitest';
import { parseMachine } from '../src/parser/markdown-parser.js';
import { compileToXState } from '../src/compiler/xstate.js';
import { compileToMermaid } from '../src/compiler/mermaid.js';

describe('XState Compiler', () => {
  it('compiles a simple machine to XState', () => {
    const machine = parseMachine(`
# machine Toggle

## context

| Field | Type | Default |
|-------|------|---------|
| count | int  | 0       |

## events

- toggle

## state off [initial]
> Off state

## state on
> On state

## transitions

| Source | Event  | Target | Action    |
|--------|--------|--------|-----------|
| off    | toggle | on     | increment |
| on     | toggle | off    | increment |

## actions

| Name      | Signature           |
|-----------|---------------------|
| increment | \`(ctx) -> Context\` |
`);
    const output = compileToXState(machine);
    expect(output).toContain("id: 'Toggle'");
    expect(output).toContain("initial: 'off'");
    expect(output).toContain("off:");
    expect(output).toContain("on:");
  });

  it('includes guards in XState output', () => {
    const machine = parseMachine(`
# machine Guarded

## context

| Field | Type | Default |
|-------|------|---------|
|       |      |         |

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
| s      | ev    | !g1   | s      |
`);
    const output = compileToXState(machine);
    expect(output).toContain('guard');
  });
});

describe('Mermaid Compiler', () => {
  it('compiles to mermaid state diagram', () => {
    const machine = parseMachine(`
# machine Simple

## context

| Field | Type | Default |
|-------|------|---------|
|       |      |         |

## events

- tick

## state idle [initial]
> Idle state

## state done [final]
> Done state

## transitions

| Source | Event | Target |
|--------|-------|--------|
| idle   | tick  | done   |
`);
    const output = compileToMermaid(machine);
    expect(output).toContain('stateDiagram-v2');
    expect(output).toContain('direction LR');
    expect(output).toContain('[*] --> idle');
    expect(output).toContain('idle --> done');
    expect(output).toContain('done --> [*]');
  });

  it('includes guard conditions in mermaid', () => {
    const machine = parseMachine(`
# machine WithGuard

## context

| Field | Type | Default |
|-------|------|---------|
|       |      |         |

## events

- ev

## guards

| Name | Expression |
|------|------------|
| g1   | \`true\`   |

## state s [initial]
> State s

## transitions

| Source | Event | Guard | Target | Action    |
|--------|-------|-------|--------|-----------|
| s      | ev    | g1    | s      | action1   |
`);
    const output = compileToMermaid(machine);
    expect(output).toContain('ev [g1]');
    expect(output).toContain('/ action1');
  });
});
