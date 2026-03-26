import { describe, it, expect } from 'vitest';
import { tokenize } from '../src/parser/lexer.js';
import { parse } from '../src/parser/parser.js';
import { checkStructural, analyzeMachine, flattenStates } from '../src/verifier/structural.js';
import { checkCompleteness } from '../src/verifier/completeness.js';
import { compileToXState, compileToXStateMachine } from '../src/compiler/xstate.js';
import { compileToMermaid } from '../src/compiler/mermaid.js';

function parseMachine(source: string) {
  return parse(tokenize(source)).machine;
}

const HIERARCHICAL_SOURCE = `
machine Game
context { score: int = 0 }
events { start, move, attack, quit }

state menu [initial] {
  description: "Main menu"
}

state playing {
  description: "Active gameplay"

  state exploring [initial] {
    description: "Exploring the map"
  }

  state fighting {
    description: "In combat"
  }
}

state done [final] {
  description: "Game over"
}

guards {
  enemy_near: true
}

transitions {
  menu + start -> playing : begin_game
  playing + move -> playing : handle_move
  playing + attack [enemy_near] -> playing : start_combat
  playing + quit -> done : save_game
  menu + quit -> done : _
}

actions {
  begin_game: (ctx: Context) -> Context
  handle_move: (ctx: Context) -> Context
  start_combat: (ctx: Context) -> Context
  save_game: (ctx: Context) -> Context
}
`;

describe('Hierarchical Parser', () => {
  it('parses compound states with children', () => {
    const machine = parseMachine(HIERARCHICAL_SOURCE);

    expect(machine.states).toHaveLength(3);
    expect(machine.states.map(s => s.name)).toEqual(['menu', 'playing', 'done']);

    const playing = machine.states.find(s => s.name === 'playing')!;
    expect(playing.contains).toBeDefined();
    expect(playing.contains).toHaveLength(2);
    expect(playing.contains![0].name).toBe('exploring');
    expect(playing.contains![1].name).toBe('fighting');
  });

  it('sets initial annotation on child states', () => {
    const machine = parseMachine(HIERARCHICAL_SOURCE);
    const playing = machine.states.find(s => s.name === 'playing')!;
    expect(playing.contains![0].isInitial).toBe(true);
    expect(playing.contains![1].isInitial).toBe(false);
  });

  it('does NOT set parent on top-level states', () => {
    const machine = parseMachine(HIERARCHICAL_SOURCE);
    for (const state of machine.states) {
      expect(state.parent).toBeUndefined();
    }
  });

  it('sets parent on nested child states', () => {
    const machine = parseMachine(HIERARCHICAL_SOURCE);
    const playing = machine.states.find(s => s.name === 'playing')!;
    for (const child of playing.contains!) {
      expect(child.parent).toBe('playing');
    }
  });

  it('rejects final compound states', () => {
    expect(() => parseMachine(`
machine Bad
context {}
events { ev }
state s [initial] {}
state end [final] {
  state inner {}
}
transitions { s + ev -> end : _ }
`)).toThrow(/cannot be both final and contain nested states/);
  });

  it('parses multiple compound states sequentially', () => {
    const machine = parseMachine(`
machine Multi
context {}
events { ev }
state lobby [initial] {
  state waiting [initial] {}
}
state game {
  state round_one [initial] {}
  state round_two {}
}
state results [final] {}
transitions {
  lobby + ev -> game : _
  game + ev -> results : _
}
`);
    expect(machine.states).toHaveLength(3);
    expect(machine.states[0].name).toBe('lobby');
    expect(machine.states[0].contains).toHaveLength(1);
    expect(machine.states[1].name).toBe('game');
    expect(machine.states[1].contains).toHaveLength(2);
    expect(machine.states[2].name).toBe('results');
    expect(machine.states[2].contains).toBeUndefined();

    // None of these top-level states should have a parent
    for (const state of machine.states) {
      expect(state.parent).toBeUndefined();
    }
  });
});

describe('Hierarchical Flattening', () => {
  it('flattens nested states into dot-notation', () => {
    const machine = parseMachine(HIERARCHICAL_SOURCE);
    const flattened = flattenStates(machine.states);
    const names = flattened.map(s => s.name);

    expect(names).toContain('menu');
    expect(names).toContain('playing');
    expect(names).toContain('playing.exploring');
    expect(names).toContain('playing.fighting');
    expect(names).toContain('done');
  });

  it('marks compound states correctly', () => {
    const machine = parseMachine(HIERARCHICAL_SOURCE);
    const flattened = flattenStates(machine.states);

    const playing = flattened.find(s => s.name === 'playing')!;
    expect(playing.isCompound).toBe(true);
    expect(playing.contains).toHaveLength(2);

    const menu = flattened.find(s => s.name === 'menu')!;
    expect(menu.isCompound).toBe(false);
  });

  it('sets parentName on children', () => {
    const machine = parseMachine(HIERARCHICAL_SOURCE);
    const flattened = flattenStates(machine.states);

    const exploring = flattened.find(s => s.name === 'playing.exploring')!;
    expect(exploring.parentName).toBe('playing');

    const menu = flattened.find(s => s.name === 'menu')!;
    expect(menu.parentName).toBeUndefined();
  });
});

describe('Hierarchical Structural Verifier', () => {
  it('passes for valid hierarchical machine', () => {
    const machine = parseMachine(HIERARCHICAL_SOURCE);
    const result = checkStructural(machine);
    const errors = result.errors.filter(e => e.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  it('builds analysis with flattened states', () => {
    const machine = parseMachine(HIERARCHICAL_SOURCE);
    const analysis = analyzeMachine(machine);

    expect(analysis.stateMap.has('menu')).toBe(true);
    expect(analysis.stateMap.has('playing')).toBe(true);
    expect(analysis.stateMap.has('playing.exploring')).toBe(true);
    expect(analysis.stateMap.has('playing.fighting')).toBe(true);
    expect(analysis.stateMap.has('done')).toBe(true);
  });
});

describe('Hierarchical Completeness Verifier', () => {
  it('passes when compound state children handle events via parent transitions', () => {
    const machine = parseMachine(HIERARCHICAL_SOURCE);
    const result = checkCompleteness(machine);
    // Compound state 'playing' handles move, attack, quit — children inherit this
    const playingErrors = result.errors.filter(e => e.location?.state === 'playing');
    // playing handles: move, attack, quit, start (via menu->playing is incoming, not relevant here)
    // playing does NOT need to handle start (it's handled by menu)
    expect(playingErrors.filter(e => e.code === 'INCOMPLETE_EVENT_HANDLING'
      && e.location?.event === 'move')).toHaveLength(0);
  });
});

describe('Hierarchical XState Compiler', () => {
  it('compiles compound states with initial and nested states', () => {
    const machine = parseMachine(HIERARCHICAL_SOURCE);
    const output = compileToXState(machine);

    // Compound state should have initial child
    expect(output).toContain("initial: 'exploring'");
    // Should contain nested states block
    expect(output).toContain('exploring:');
    expect(output).toContain('fighting:');
  });

  it('does not emit type: initial for any state', () => {
    const machine = parseMachine(HIERARCHICAL_SOURCE);
    const output = compileToXState(machine);
    expect(output).not.toContain("type: 'initial'");
  });

  it('emits type: final only for final states', () => {
    const machine = parseMachine(HIERARCHICAL_SOURCE);
    const output = compileToXState(machine);
    expect(output).toContain("type: 'final'");
  });

  it('compileToXStateMachine produces valid config for compound states', () => {
    const machine = parseMachine(HIERARCHICAL_SOURCE);
    const compiled = compileToXStateMachine(machine);

    expect(compiled.config.initial).toBe('menu');
    expect(compiled.config.states.playing).toBeDefined();
    expect(compiled.config.states.playing.initial).toBe('exploring');
    expect(compiled.config.states.playing.states).toBeDefined();
    expect(compiled.config.states.playing.states.exploring).toBeDefined();
    expect(compiled.config.states.playing.states.fighting).toBeDefined();
  });

  it('config does not include type: initial on any state', () => {
    const machine = parseMachine(HIERARCHICAL_SOURCE);
    const compiled = compileToXStateMachine(machine);

    // Check leaf states don't have type: 'initial'
    expect(compiled.config.states.menu.type).toBeUndefined();
    expect(compiled.config.states.playing.states.exploring.type).toBeUndefined();
    expect(compiled.config.states.playing.states.fighting.type).toBeUndefined();

    // Final state should have type: 'final'
    expect(compiled.config.states.done.type).toBe('final');
  });
});

describe('Hierarchical Mermaid Compiler', () => {
  it('renders compound states with nesting syntax', () => {
    const machine = parseMachine(HIERARCHICAL_SOURCE);
    const output = compileToMermaid(machine);

    expect(output).toContain('state playing {');
    expect(output).toContain('[*] --> exploring');
    expect(output).toContain('done --> [*]');
  });

  it('renders initial transition inside compound block', () => {
    const machine = parseMachine(HIERARCHICAL_SOURCE);
    const output = compileToMermaid(machine);

    // The initial child of 'playing' is 'exploring'
    const lines = output.split('\n');
    const playingLine = lines.findIndex(l => l.includes('state playing {'));
    const innerInitial = lines.findIndex((l, i) => i > playingLine && l.includes('[*] --> exploring'));
    expect(innerInitial).toBeGreaterThan(playingLine);
  });

  it('preserves top-level transitions', () => {
    const machine = parseMachine(HIERARCHICAL_SOURCE);
    const output = compileToMermaid(machine);

    expect(output).toContain('menu --> playing : start');
    expect(output).toContain('playing --> playing : move / handle_move');
  });

  it('renders deeply nested compound states', () => {
    const machine = parseMachine(`
machine Deep
context {}
events { go }
state top [initial] {
  state mid [initial] {
    state leaf [initial] {}
  }
}
state end [final] {}
transitions { top + go -> end : _ }
`);
    const output = compileToMermaid(machine);
    expect(output).toContain('state top {');
    expect(output).toContain('state mid {');
    expect(output).toContain('[*] --> leaf');
  });
});

describe('Hierarchical Effect Error Target', () => {
  it('uses failed state as error target when it exists', () => {
    const machine = parseMachine(`
machine WithFailed
context {}
events { submit, done_ev, fail_ev }
state idle [initial] {
  on_entry: -> do_work
}
state success [final] {}
state failed [final] {}
transitions {
  idle + done_ev -> success : _
  idle + fail_ev -> failed : _
}
actions {
  do_work: (ctx: Context) -> Context + Effect<Work>
}
`);
    const compiled = compileToXStateMachine(machine);
    const idleConfig = compiled.config.states.idle;
    expect(idleConfig.invoke).toBeDefined();
    expect(idleConfig.invoke.onError.target).toBe('failed');
  });

  it('omits error target when no error/failed state exists', () => {
    const machine = parseMachine(`
machine NoErrorState
context {}
events { submit, done_ev }
state idle [initial] {
  on_entry: -> do_work
}
state success [final] {}
transitions {
  idle + done_ev -> success : _
}
actions {
  do_work: (ctx: Context) -> Context + Effect<Work>
}
`);
    const compiled = compileToXStateMachine(machine);
    const idleConfig = compiled.config.states.idle;
    expect(idleConfig.invoke).toBeDefined();
    expect(idleConfig.invoke.onError.target).toBeUndefined();
  });

  it('prefers error state over failed state', () => {
    const machine = parseMachine(`
machine WithBoth
context {}
events { submit, done_ev }
state idle [initial] {
  on_entry: -> do_work
}
state success [final] {}
state error [final] {}
state failed [final] {}
transitions {
  idle + done_ev -> success : _
}
actions {
  do_work: (ctx: Context) -> Context + Effect<Work>
}
`);
    const compiled = compileToXStateMachine(machine);
    const idleConfig = compiled.config.states.idle;
    expect(idleConfig.invoke.onError.target).toBe('error');
  });
});
