import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseMarkdown } from '../src/parser/markdown-parser.js';
import { machineToMarkdown } from '../src/parser/ast-to-markdown.js';
import { tokenize } from '../src/parser/lexer.js';
import { parse } from '../src/parser/parser.js';

describe('Markdown Parser', () => {
  describe('minimal machine', () => {
    it('parses a simple two-state machine', () => {
      const result = parseMarkdown(`
# machine Minimal

## events

- tick

## state idle [initial]
> Waiting for tick

## state done [final]
> Finished

## transitions

| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| idle | tick | | done | |
`);
      expect(result.machine.name).toBe('Minimal');
      expect(result.machine.states).toHaveLength(2);
      expect(result.machine.states[0].name).toBe('idle');
      expect(result.machine.states[0].isInitial).toBe(true);
      expect(result.machine.states[0].description).toBe('Waiting for tick');
      expect(result.machine.states[1].name).toBe('done');
      expect(result.machine.states[1].isFinal).toBe(true);
      expect(result.machine.transitions).toHaveLength(1);
      expect(result.machine.transitions[0]).toEqual({
        source: 'idle', event: 'tick', target: 'done',
      });
    });
  });

  describe('context parsing', () => {
    it('parses context table with types and defaults', () => {
      const result = parseMarkdown(`
# machine CtxTest

## context

| Field | Type | Default |
|-------|------|---------|
| name | string | |
| count | int | 0 |
| amount | decimal | |
| token | string? | |
| items | string[] | |
| flags | map<string, bool> | |

## state s [initial]

## transitions

| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
`);
      const ctx = result.machine.context;
      expect(ctx).toHaveLength(6);
      expect(ctx[0]).toEqual({ name: 'name', type: { kind: 'string' } });
      expect(ctx[1]).toEqual({ name: 'count', type: { kind: 'int' }, defaultValue: '0' });
      expect(ctx[2]).toEqual({ name: 'amount', type: { kind: 'decimal' } });
      expect(ctx[3]).toEqual({ name: 'token', type: { kind: 'optional', innerType: 'string' } });
      expect(ctx[4]).toEqual({ name: 'items', type: { kind: 'array', elementType: 'string' } });
      expect(ctx[5]).toEqual({ name: 'flags', type: { kind: 'map', keyType: 'string', valueType: 'bool' } });
    });
  });

  describe('events parsing', () => {
    it('parses bullet list events', () => {
      const result = parseMarkdown(`
# machine EvTest

## events

- start
- stop
- reset

## state s [initial]
`);
      expect(result.machine.events).toHaveLength(3);
      expect(result.machine.events.map(e => e.name)).toEqual(['start', 'stop', 'reset']);
    });

    it('parses comma-separated events on one line', () => {
      const result = parseMarkdown(`
# machine EvTest

## events

- go_north, go_south
- attack, defend, flee

## state s [initial]
`);
      expect(result.machine.events).toHaveLength(5);
      expect(result.machine.events.map(e => e.name)).toEqual([
        'go_north', 'go_south', 'attack', 'defend', 'flee',
      ]);
    });
  });

  describe('state parsing', () => {
    it('parses state properties (on_entry, on_exit, timeout, ignore)', () => {
      const result = parseMarkdown(`
# machine StateTest

## events

- ev

## state idle [initial]
> Waiting
- on_entry: setup
- on_exit: cleanup
- timeout: 30s -> timed_out
- ignore: ev

## state timed_out [final]
`);
      const s = result.machine.states[0];
      expect(s.name).toBe('idle');
      expect(s.description).toBe('Waiting');
      expect(s.onEntry).toBe('setup');
      expect(s.onExit).toBe('cleanup');
      expect(s.timeout).toEqual({ duration: '30s', target: 'timed_out' });
      expect(s.ignoredEvents).toEqual(['ev']);
    });

    it('parses comma-separated ignore events', () => {
      const result = parseMarkdown(`
# machine IgnoreTest

## events

- a, b, c

## state s [initial]
- ignore: a, b, c
`);
      expect(result.machine.states[0].ignoredEvents).toEqual(['a', 'b', 'c']);
    });
  });

  describe('guards parsing', () => {
    it('parses guard expressions from table', () => {
      const result = parseMarkdown(`
# machine GuardTest

## state s [initial]

## guards

| Name | Expression |
|------|------------|
| can_retry | \`ctx.retry_count < 3\` |
| has_token | \`ctx.payment_token != null\` |
| always | \`true\` |
`);
      expect(result.machine.guards).toHaveLength(3);
      expect(result.machine.guards[0].name).toBe('can_retry');
      expect(result.machine.guards[0].expression).toEqual({
        kind: 'compare', op: 'lt',
        left: { kind: 'variable', path: ['ctx', 'retry_count'] },
        right: { kind: 'value', type: 'number', value: 3 },
      });
      expect(result.machine.guards[1].expression).toEqual({
        kind: 'compare', op: 'ne',
        left: { kind: 'variable', path: ['ctx', 'payment_token'] },
        right: { kind: 'value', type: 'null', value: null },
      });
      expect(result.machine.guards[2].expression).toEqual({ kind: 'true' });
    });

    it('parses complex guard expressions with and/or', () => {
      const result = parseMarkdown(`
# machine ComplexGuard

## state s [initial]

## guards

| Name | Expression |
|------|------------|
| complex | \`(ctx.health > 0 and ctx.ammo > 0) or ctx.mode == "god"\` |
`);
      const expr = result.machine.guards[0].expression;
      expect(expr.kind).toBe('or');
    });
  });

  describe('transitions parsing', () => {
    it('parses transitions table with guards', () => {
      const result = parseMarkdown(`
# machine TransTest

## state idle [initial]
## state done [final]

## transitions

| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| idle | start | | done | do_start |
| idle | retry | can_retry | idle | inc |
| idle | retry | !can_retry | done | fail |
`);
      expect(result.machine.transitions).toHaveLength(3);
      expect(result.machine.transitions[0]).toEqual({
        source: 'idle', event: 'start', target: 'done', action: 'do_start',
      });
      expect(result.machine.transitions[1].guard).toEqual({ name: 'can_retry', negated: false });
      expect(result.machine.transitions[2].guard).toEqual({ name: 'can_retry', negated: true });
    });

    it('treats _ action as no action', () => {
      const result = parseMarkdown(`
# machine ActionTest

## state s [initial]
## state t [final]

## transitions

| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| s | ev | | t | _ |
`);
      expect(result.machine.transitions[0].action).toBeUndefined();
    });
  });

  describe('actions parsing', () => {
    it('parses action signatures from table', () => {
      const result = parseMarkdown(`
# machine ActTest

## state s [initial]

## actions

| Name | Signature |
|------|-----------|
| reset | \`() -> Context\` |
| handle | \`(ctx, event) -> Context\` |
| send | \`(ctx) -> Context + Effect<Request>\` |
`);
      expect(result.machine.actions).toHaveLength(3);
      expect(result.machine.actions[0]).toEqual({
        name: 'reset', parameters: [], returnType: 'Context', hasEffect: false, effectType: undefined,
      });
      expect(result.machine.actions[1]).toEqual({
        name: 'handle', parameters: ['ctx', 'event'], returnType: 'Context', hasEffect: false, effectType: undefined,
      });
      expect(result.machine.actions[2]).toEqual({
        name: 'send', parameters: ['ctx'], returnType: 'Context', hasEffect: true, effectType: 'Request',
      });
    });
  });

  describe('hierarchical states', () => {
    it('parses nested states from heading levels', () => {
      const result = parseMarkdown(`
# machine HierTest

## events

- go, attack

## state idle [initial]
> Main menu

## state exploration
> Exploring

### state overworld [initial]
> In the overworld

### state dungeon
> In a dungeon

## state combat
> Fighting

### state attacking [initial]
> Attacking

### state defending
> Defending

## state game_over [final]
`);
      expect(result.machine.states).toHaveLength(4);
      expect(result.machine.states[0].name).toBe('idle');

      const exploration = result.machine.states[1];
      expect(exploration.name).toBe('exploration');
      expect(exploration.contains).toHaveLength(2);
      expect(exploration.contains![0].name).toBe('overworld');
      expect(exploration.contains![0].isInitial).toBe(true);
      expect(exploration.contains![0].parent).toBe('exploration');
      expect(exploration.contains![1].name).toBe('dungeon');
      expect(exploration.contains![1].parent).toBe('exploration');

      const combat = result.machine.states[2];
      expect(combat.contains).toHaveLength(2);
      expect(combat.contains![0].name).toBe('attacking');
      expect(combat.contains![0].parent).toBe('combat');
    });
  });

  describe('parallel states', () => {
    it('parses parallel regions', () => {
      const result = parseMarkdown(`
# machine ParallelTest

## events

- PLACE_ORDER, PAY, NOTIFY

## state idle [initial]

## state processing [parallel]
> Processing order
- on_entry: initOrder
- on_done: -> completed
- ignore: PLACE_ORDER

### region payment_flow

#### state charging [initial]
> Charging

#### state paid [final]
> Paid

### region notification_flow

#### state sending [initial]
> Sending

#### state notified [final]
> Notified

## state completed [final]
`);
      expect(result.machine.states).toHaveLength(3);

      const processing = result.machine.states[1];
      expect(processing.name).toBe('processing');
      expect(processing.onEntry).toBe('initOrder');
      expect(processing.onDone).toBe('completed');
      expect(processing.ignoredEvents).toEqual(['PLACE_ORDER']);
      expect(processing.parallel).toBeDefined();
      expect(processing.parallel!.regions).toHaveLength(2);

      const payment = processing.parallel!.regions[0];
      expect(payment.name).toBe('payment_flow');
      expect(payment.states).toHaveLength(2);
      expect(payment.states[0].name).toBe('charging');
      expect(payment.states[0].isInitial).toBe(true);
      expect(payment.states[0].parent).toBe('processing.payment_flow');
      expect(payment.states[1].name).toBe('paid');
      expect(payment.states[1].isFinal).toBe(true);

      const notif = processing.parallel!.regions[1];
      expect(notif.name).toBe('notification_flow');
      expect(notif.states).toHaveLength(2);
    });

    it('parses sync strategy annotation', () => {
      const result = parseMarkdown(`
# machine SyncTest

## state idle [initial]

## state proc [parallel, sync: any-final]
- on_done: -> done

### region r1

#### state a [initial]
#### state b [final]

### region r2

#### state c [initial]
#### state d [final]

## state done [final]
`);
      expect(result.machine.states[1].parallel!.sync).toBe('any-final');
    });
  });

  describe('properties parsing', () => {
    it('parses all property types', () => {
      const result = parseMarkdown(`
# machine PropTest

## state idle [initial]
## state auth
## state settled [final]
## state failed [final]

## properties

- reachable: auth from idle
- unreachable: settled from failed
- passes_through: auth for idle -> settled
- live
- responds: settled from idle within 5
- invariant: \`ctx.retry_count <= 3\`
`);
      const props = result.machine.properties!;
      expect(props).toHaveLength(6);
      expect(props[0]).toEqual({ kind: 'reachable', from: 'idle', to: 'auth' });
      expect(props[1]).toEqual({ kind: 'unreachable', from: 'failed', to: 'settled' });
      expect(props[2]).toEqual({ kind: 'passes_through', from: 'idle', to: 'settled', through: 'auth' });
      expect(props[3]).toEqual({ kind: 'live' });
      expect(props[4]).toEqual({ kind: 'responds', from: 'idle', to: 'settled', within: 5 });
      expect(props[5].kind).toBe('invariant');
    });

    it('parses invariant with in-state scope', () => {
      const result = parseMarkdown(`
# machine InvTest

## state combat [initial]

## properties

- invariant: \`ctx.health > 0\` in combat
`);
      const prop = result.machine.properties![0];
      expect(prop.kind).toBe('invariant');
      if (prop.kind === 'invariant') {
        expect(prop.inState).toBe('combat');
      }
    });
  });

  describe('embedded machine support', () => {
    it('ignores prose before machine heading', () => {
      const result = parseMarkdown(`
# Design Document

This is some prose that should be ignored.

# machine MyMachine

## events

- start

## state idle [initial]
## state done [final]

## transitions

| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| idle | start | | done | |
`);
      expect(result.machine.name).toBe('MyMachine');
      expect(result.machine.states).toHaveLength(2);
    });

    it('ignores fenced code blocks', () => {
      const result = parseMarkdown(`
# machine CodeBlockTest

\`\`\`
## state fake
This is inside a code block and should be ignored.
\`\`\`

## events

- tick

## state s [initial]
`);
      expect(result.machine.name).toBe('CodeBlockTest');
      expect(result.machine.states).toHaveLength(1);
      expect(result.machine.states[0].name).toBe('s');
    });
  });

  describe('sections in any order', () => {
    it('accepts sections in non-standard order', () => {
      const result = parseMarkdown(`
# machine OrderTest

## guards

| Name | Expression |
|------|------------|
| ok | \`true\` |

## transitions

| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| s | ev | ok | s | |

## state s [initial]

## events

- ev

## context

| Field | Type | Default |
|-------|------|---------|
| x | int | 0 |
`);
      expect(result.machine.name).toBe('OrderTest');
      expect(result.machine.context).toHaveLength(1);
      expect(result.machine.events).toHaveLength(1);
      expect(result.machine.guards).toHaveLength(1);
      expect(result.machine.states).toHaveLength(1);
      expect(result.machine.transitions).toHaveLength(1);
    });
  });
});

describe('AST to Markdown Converter', () => {
  it('converts a simple machine to markdown', () => {
    const md = machineToMarkdown({
      name: 'Simple',
      context: [{ name: 'count', type: { kind: 'int' }, defaultValue: '0' }],
      events: [{ name: 'tick' }],
      states: [
        { name: 'idle', isInitial: true, isFinal: false, description: 'Waiting' },
        { name: 'done', isInitial: false, isFinal: true },
      ],
      transitions: [{ source: 'idle', event: 'tick', target: 'done' }],
      guards: [],
      actions: [],
    });

    expect(md).toContain('# machine Simple');
    expect(md).toContain('## state idle [initial]');
    expect(md).toContain('> Waiting');
    expect(md).toContain('## state done [final]');
    expect(md).toContain('| idle');
    expect(md).toContain('tick');
  });
});

describe('Round-trip: DSL → AST → Markdown → AST', () => {
  function roundTrip(orcaSource: string) {
    const dslResult = parse(tokenize(orcaSource));
    const md = machineToMarkdown(dslResult.machine);
    const mdResult = parseMarkdown(md);
    return { dslMachine: dslResult.machine, mdMachine: mdResult.machine };
  }

  function stripParentsAndTokens(machine: any): any {
    // Deep clone and strip parent refs (which are set differently for top-level states)
    // and normalize empty arrays/undefined
    return JSON.parse(JSON.stringify(machine, (key, value) => {
      if (key === 'tokens') return undefined;
      return value;
    }));
  }

  it('round-trips simple-toggle', () => {
    const source = readFileSync(join(__dirname, '../examples/simple-toggle.orca'), 'utf-8');
    const { dslMachine, mdMachine } = roundTrip(source);
    expect(stripParentsAndTokens(mdMachine)).toEqual(stripParentsAndTokens(dslMachine));
  });

  it('round-trips payment-processor', () => {
    const source = readFileSync(join(__dirname, '../examples/payment-processor.orca'), 'utf-8');
    const { dslMachine, mdMachine } = roundTrip(source);
    expect(stripParentsAndTokens(mdMachine)).toEqual(stripParentsAndTokens(dslMachine));
  });

  it('round-trips text-adventure', () => {
    const source = readFileSync(join(__dirname, '../examples/text-adventure.orca'), 'utf-8');
    const { dslMachine, mdMachine } = roundTrip(source);
    expect(stripParentsAndTokens(mdMachine)).toEqual(stripParentsAndTokens(dslMachine));
  });

  it('round-trips hierarchical-game', () => {
    const source = readFileSync(join(__dirname, '../examples/hierarchical-game.orca'), 'utf-8');
    const { dslMachine, mdMachine } = roundTrip(source);
    expect(stripParentsAndTokens(mdMachine)).toEqual(stripParentsAndTokens(dslMachine));
  });

  it('round-trips parallel-order', () => {
    const source = readFileSync(join(__dirname, '../examples/parallel-order.orca'), 'utf-8');
    const { dslMachine, mdMachine } = roundTrip(source);
    expect(stripParentsAndTokens(mdMachine)).toEqual(stripParentsAndTokens(dslMachine));
  });

  it('round-trips payment-with-properties', () => {
    const source = readFileSync(join(__dirname, '../examples/payment-with-properties.orca'), 'utf-8');
    const { dslMachine, mdMachine } = roundTrip(source);
    expect(stripParentsAndTokens(mdMachine)).toEqual(stripParentsAndTokens(dslMachine));
  });
});
