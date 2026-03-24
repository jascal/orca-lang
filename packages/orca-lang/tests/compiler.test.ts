import { describe, it, expect } from 'vitest';
import { tokenize } from '../src/parser/lexer.js';
import { parse } from '../src/parser/parser.js';
import { compileToXState } from '../src/compiler/xstate.js';
import { compileToMermaid } from '../src/compiler/mermaid.js';

function parseMachine(source: string) {
  return parse(tokenize(source)).machine;
}

describe('XState Compiler', () => {
  it('compiles a simple machine to XState', () => {
    const machine = parseMachine(`
machine Toggle
context { count: int = 0 }
events { toggle }
state off [initial] {}
state on {}
transitions {
  off + toggle -> on : increment
  on  + toggle -> off : increment
}
actions {
  increment: (ctx: Context) -> Context
}
`);
    const output = compileToXState(machine);
    expect(output).toContain("id: 'Toggle'");
    expect(output).toContain("initial: 'off'");
    expect(output).toContain("off:");
    expect(output).toContain("on:");
  });

  it('includes guards in XState output', () => {
    const machine = parseMachine(`
machine Guarded
context {}
events { ev }
guards { g1: true }
state s [initial] {}
transitions {
  s + ev [g1] -> s : _
  s + ev [!g1] -> s : _
}
`);
    const output = compileToXState(machine);
    expect(output).toContain('guard');
  });
});

describe('Mermaid Compiler', () => {
  it('compiles to mermaid state diagram', () => {
    const machine = parseMachine(`
machine Simple
context {}
events { tick }
state idle [initial] {}
state done [final] {}
transitions {
  idle + tick -> done : _
}
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
machine WithGuard
context {}
events { ev }
guards { g1: true }
state s [initial] {}
transitions {
  s + ev [g1] -> s : action1
}
`);
    const output = compileToMermaid(machine);
    expect(output).toContain('ev [g1]');
    expect(output).toContain('/ action1');
  });
});
