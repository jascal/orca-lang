import { describe, it, expect } from 'vitest';
import { tokenize } from '../src/parser/lexer.js';
import { parse } from '../src/parser/parser.js';

describe('Lexer', () => {
  it('tokenizes a simple machine', () => {
    const tokens = tokenize(`
machine Test
context {
  name: string
  count: int = 0
}
events {
  start, stop
}
`);
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens[0].type).toBe('MACHINE');
    expect(tokens[1].value).toBe('Test');
  });
});

describe('Parser', () => {
  it('parses a minimal machine', () => {
    const source = `
machine Minimal
context {
  value: int
}
events {
  tick
}
state idle [initial] {}
state done [final] {}
transitions {
  idle + tick -> done : _
}
`;
    const tokens = tokenize(source);
    const result = parse(tokens);
    expect(result.machine.name).toBe('Minimal');
    expect(result.machine.states).toHaveLength(2);
    expect(result.machine.transitions).toHaveLength(1);
  });

  it('parses payment processor example', () => {
    const source = `
machine PaymentProcessor
context {
  order_id: string
  amount: decimal
  retry_count: int = 0
}
events {
  submit_payment
  payment_authorized
  retry_requested
}
state idle [initial] {}
state failed [final] {}
guards {
  can_retry: ctx.retry_count < 3
}
transitions {
  idle + submit_payment -> idle : _
}
`;
    const tokens = tokenize(source);
    const result = parse(tokens);
    expect(result.machine.name).toBe('PaymentProcessor');
    expect(result.machine.context).toHaveLength(3);
    expect(result.machine.events).toHaveLength(3);
  });

  it('parses guards correctly', () => {
    const source = `
machine GuardTest
context { value: int }
events { ev }
guards {
  positive: ctx.value > 0
  negative: ctx.value < 0
}
state s [initial] {}
transitions {
  s + ev [positive] -> s : _
  s + ev [!positive] -> s : _
}
`;
    const tokens = tokenize(source);
    const result = parse(tokens);
    expect(result.machine.guards).toHaveLength(2);
    expect(result.machine.transitions[0].guard?.name).toBe('positive');
    expect(result.machine.transitions[0].guard?.negated).toBe(false);
    expect(result.machine.transitions[1].guard?.negated).toBe(true);
  });
});
