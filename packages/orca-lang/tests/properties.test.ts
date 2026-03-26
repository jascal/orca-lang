import { describe, it, expect } from 'vitest';
import { tokenize } from '../src/parser/lexer.js';
import { parse } from '../src/parser/parser.js';
import { checkProperties } from '../src/verifier/properties.js';
import { MachineDef, Property } from '../src/parser/ast.js';

// Helper to parse an orca source and return the machine
function parseMachine(source: string): MachineDef {
  const tokens = tokenize(source);
  const result = parse(tokens);
  return result.machine;
}

// Minimal valid machine for property testing
const baseMachine = `
machine TestMachine

context {
  count: int = 0
  status: string
}

events {
  go
  advance
  fail
  retry
  complete
}

state idle [initial] {
  description: "Start state"
}

state processing {
  description: "Processing"
}

state validated {
  description: "Validated"
}

state completed [final] {
  description: "Done"
}

state failed [final] {
  description: "Failed"
}

transitions {
  idle       + go       -> processing  : _
  processing + advance  -> validated   : _
  processing + fail     -> failed      : _
  validated  + complete -> completed   : _
  validated  + fail     -> failed      : _
}

actions {}
`;

// ---- Parser Tests ----

describe('Property Parser', () => {
  it('parses reachable property', () => {
    const source = baseMachine.replace('actions {}', 'actions {}\n\nproperties {\n  reachable: completed from idle\n}');
    const machine = parseMachine(source);
    expect(machine.properties).toBeDefined();
    expect(machine.properties!.length).toBe(1);
    expect(machine.properties![0]).toEqual({ kind: 'reachable', from: 'idle', to: 'completed' });
  });

  it('parses unreachable property', () => {
    const source = baseMachine.replace('actions {}', 'actions {}\n\nproperties {\n  unreachable: completed from failed\n}');
    const machine = parseMachine(source);
    expect(machine.properties![0]).toEqual({ kind: 'unreachable', from: 'failed', to: 'completed' });
  });

  it('parses passes_through property', () => {
    const source = baseMachine.replace('actions {}', 'actions {}\n\nproperties {\n  passes_through: validated for idle -> completed\n}');
    const machine = parseMachine(source);
    expect(machine.properties![0]).toEqual({
      kind: 'passes_through',
      from: 'idle',
      to: 'completed',
      through: 'validated',
    });
  });

  it('parses live property', () => {
    const source = baseMachine.replace('actions {}', 'actions {}\n\nproperties {\n  live\n}');
    const machine = parseMachine(source);
    expect(machine.properties![0]).toEqual({ kind: 'live' });
  });

  it('parses responds property', () => {
    const source = baseMachine.replace('actions {}', 'actions {}\n\nproperties {\n  responds: completed from idle within 5\n}');
    const machine = parseMachine(source);
    expect(machine.properties![0]).toEqual({ kind: 'responds', from: 'idle', to: 'completed', within: 5 });
  });

  it('parses invariant property without state', () => {
    const source = baseMachine.replace('actions {}', 'actions {}\n\nproperties {\n  invariant: ctx.count <= 3\n}');
    const machine = parseMachine(source);
    expect(machine.properties![0].kind).toBe('invariant');
    const inv = machine.properties![0] as import('../src/parser/ast.js').InvariantProperty;
    expect(inv.inState).toBeUndefined();
    expect(inv.expression.kind).toBe('compare');
  });

  it('parses invariant property with state', () => {
    const source = baseMachine.replace('actions {}', 'actions {}\n\nproperties {\n  invariant: ctx.count < 10 in processing\n}');
    const machine = parseMachine(source);
    const inv = machine.properties![0] as import('../src/parser/ast.js').InvariantProperty;
    expect(inv.inState).toBe('processing');
  });

  it('parses multiple properties', () => {
    const source = baseMachine.replace('actions {}', `actions {}

properties {
  reachable: completed from idle
  unreachable: completed from failed
  live
  responds: completed from idle within 3
}`);
    const machine = parseMachine(source);
    expect(machine.properties!.length).toBe(4);
    expect(machine.properties![0].kind).toBe('reachable');
    expect(machine.properties![1].kind).toBe('unreachable');
    expect(machine.properties![2].kind).toBe('live');
    expect(machine.properties![3].kind).toBe('responds');
  });

  it('parses dot-notation state names', () => {
    const source = baseMachine.replace('actions {}', 'actions {}\n\nproperties {\n  reachable: parent.child from root.start\n}');
    const machine = parseMachine(source);
    const prop = machine.properties![0] as import('../src/parser/ast.js').ReachabilityProperty;
    expect(prop.from).toBe('root.start');
    expect(prop.to).toBe('parent.child');
  });

  it('errors on unknown property type', () => {
    const source = baseMachine.replace('actions {}', 'actions {}\n\nproperties {\n  bogus: foo\n}');
    expect(() => parseMachine(source)).toThrow(/Unknown property type 'bogus'/);
  });

  it('machine without properties block has no properties field', () => {
    const machine = parseMachine(baseMachine);
    expect(machine.properties).toBeUndefined();
  });
});

// ---- Reachability Tests ----

describe('Property: reachable', () => {
  it('passes when target is reachable', () => {
    const source = baseMachine.replace('actions {}', 'actions {}\n\nproperties {\n  reachable: completed from idle\n}');
    const result = checkProperties(parseMachine(source));
    expect(result.valid).toBe(true);
    expect(result.errors.filter(e => e.severity === 'error')).toHaveLength(0);
  });

  it('fails when target is not reachable', () => {
    const source = baseMachine.replace('actions {}', 'actions {}\n\nproperties {\n  reachable: idle from failed\n}');
    const result = checkProperties(parseMachine(source));
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'PROPERTY_REACHABILITY_FAIL')).toBe(true);
  });

  it('errors on invalid state name', () => {
    const source = baseMachine.replace('actions {}', 'actions {}\n\nproperties {\n  reachable: nonexistent from idle\n}');
    const result = checkProperties(parseMachine(source));
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'PROPERTY_INVALID_STATE')).toBe(true);
  });
});

// ---- Exclusion Tests ----

describe('Property: unreachable', () => {
  it('passes when target is truly unreachable', () => {
    const source = baseMachine.replace('actions {}', 'actions {}\n\nproperties {\n  unreachable: completed from failed\n}');
    const result = checkProperties(parseMachine(source));
    expect(result.valid).toBe(true);
    expect(result.errors.filter(e => e.severity === 'error')).toHaveLength(0);
  });

  it('fails with counterexample when target is reachable', () => {
    const source = baseMachine.replace('actions {}', 'actions {}\n\nproperties {\n  unreachable: completed from idle\n}');
    const result = checkProperties(parseMachine(source));
    expect(result.valid).toBe(false);
    const err = result.errors.find(e => e.code === 'PROPERTY_EXCLUSION_FAIL');
    expect(err).toBeDefined();
    expect(err!.message).toContain('path exists');
  });
});

// ---- Pass-through Tests ----

describe('Property: passes_through', () => {
  it('passes when all paths go through intermediate', () => {
    // In the base machine: idle -> processing -> validated -> completed
    // The only path from idle to completed goes through validated
    const source = baseMachine.replace('actions {}', 'actions {}\n\nproperties {\n  passes_through: validated for idle -> completed\n}');
    const result = checkProperties(parseMachine(source));
    expect(result.valid).toBe(true);
  });

  it('passes when intermediate is on every path', () => {
    // idle -> processing is the only way out of idle, so processing is on every path
    const source = baseMachine.replace('actions {}', 'actions {}\n\nproperties {\n  passes_through: processing for idle -> completed\n}');
    const result = checkProperties(parseMachine(source));
    expect(result.valid).toBe(true);
  });

  it('fails when a path bypasses the intermediate', () => {
    // Add a shortcut: idle -> completed directly
    const machineWithShortcut = baseMachine
      .replace('validated  + fail     -> failed      : _', 'validated  + fail     -> failed      : _\n  idle       + complete -> completed   : _')
      .replace('actions {}', 'actions {}\n\nproperties {\n  passes_through: processing for idle -> completed\n}');
    const result = checkProperties(parseMachine(machineWithShortcut));
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'PROPERTY_PATH_FAIL')).toBe(true);
  });

  it('fails when target is not reachable at all', () => {
    const source = baseMachine.replace('actions {}', 'actions {}\n\nproperties {\n  passes_through: processing for failed -> idle\n}');
    const result = checkProperties(parseMachine(source));
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('not reachable');
  });
});

// ---- Liveness Tests ----

describe('Property: live', () => {
  it('passes when all reachable states can reach a final state', () => {
    const source = baseMachine.replace('actions {}', 'actions {}\n\nproperties {\n  live\n}');
    const result = checkProperties(parseMachine(source));
    expect(result.valid).toBe(true);
  });

  it('fails when a reachable state cannot reach any final state', () => {
    // Create a machine with a trap state
    const trapMachine = `
machine TrapMachine
context {}
events { go, trap_event }

state start [initial] {}
state normal {}
state trap {}
state done [final] {}

transitions {
  start  + go         -> normal     : _
  start  + trap_event -> trap       : _
  normal + go         -> done       : _
}

actions {}

properties {
  live
}`;
    const result = checkProperties(parseMachine(trapMachine));
    expect(result.valid).toBe(false);
    const err = result.errors.find(e => e.code === 'PROPERTY_LIVENESS_FAIL');
    expect(err).toBeDefined();
    expect(err!.message).toContain('trap');
  });
});

// ---- Bounded Response Tests ----

describe('Property: responds', () => {
  it('passes when target reachable within bound', () => {
    // idle -> processing -> validated -> completed = 3 transitions
    const source = baseMachine.replace('actions {}', 'actions {}\n\nproperties {\n  responds: completed from idle within 3\n}');
    const result = checkProperties(parseMachine(source));
    expect(result.valid).toBe(true);
  });

  it('fails when target is beyond the bound', () => {
    // idle -> processing -> validated -> completed = 3 transitions, bound is 2
    const source = baseMachine.replace('actions {}', 'actions {}\n\nproperties {\n  responds: completed from idle within 2\n}');
    const result = checkProperties(parseMachine(source));
    expect(result.valid).toBe(false);
    const err = result.errors.find(e => e.code === 'PROPERTY_RESPONSE_FAIL');
    expect(err).toBeDefined();
    expect(err!.message).toContain('reachable beyond 2 transitions');
  });

  it('fails when target is not reachable at all', () => {
    const source = baseMachine.replace('actions {}', 'actions {}\n\nproperties {\n  responds: idle from failed within 10\n}');
    const result = checkProperties(parseMachine(source));
    expect(result.valid).toBe(false);
    const err = result.errors.find(e => e.code === 'PROPERTY_RESPONSE_FAIL');
    expect(err!.message).toContain('not reachable at all');
  });
});

// ---- Invariant Tests ----

describe('Property: invariant', () => {
  it('warns as advisory when invariant is valid', () => {
    const source = baseMachine.replace('actions {}', 'actions {}\n\nproperties {\n  invariant: ctx.count <= 3\n}');
    const result = checkProperties(parseMachine(source));
    // Should pass (no errors), but have an advisory warning
    expect(result.valid).toBe(true);
    expect(result.errors.some(e => e.code === 'PROPERTY_INVARIANT_ADVISORY')).toBe(true);
  });

  it('errors on undeclared context field', () => {
    const source = baseMachine.replace('actions {}', 'actions {}\n\nproperties {\n  invariant: ctx.nonexistent_field < 5\n}');
    const result = checkProperties(parseMachine(source));
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'PROPERTY_INVARIANT_INVALID')).toBe(true);
  });

  it('errors on invalid state reference', () => {
    const source = baseMachine.replace('actions {}', 'actions {}\n\nproperties {\n  invariant: ctx.count < 5 in nonexistent_state\n}');
    const result = checkProperties(parseMachine(source));
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'PROPERTY_INVALID_STATE')).toBe(true);
  });
});

// ---- Machine Size Limit Tests ----

describe('Machine Size Limit', () => {
  it('passes for normal-sized machines', () => {
    const result = checkProperties(parseMachine(baseMachine));
    expect(result.valid).toBe(true);
  });

  it('fails when exceeding custom max_states', () => {
    const result = checkProperties(parseMachine(baseMachine), { maxStates: 3 });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'MACHINE_TOO_LARGE')).toBe(true);
  });

  it('includes state count in error message', () => {
    const result = checkProperties(parseMachine(baseMachine), { maxStates: 2 });
    const err = result.errors.find(e => e.code === 'MACHINE_TOO_LARGE');
    expect(err).toBeDefined();
    expect(err!.message).toContain('5 states');
    expect(err!.message).toContain('limit: 2');
  });
});

// ---- Integration: Multiple Properties ----

describe('Multiple Properties', () => {
  it('checks all properties and collects all errors', () => {
    const source = baseMachine.replace('actions {}', `actions {}

properties {
  reachable: completed from idle
  unreachable: completed from failed
  passes_through: processing for idle -> completed
  live
  responds: completed from idle within 3
}`);
    const result = checkProperties(parseMachine(source));
    expect(result.valid).toBe(true);
    expect(result.errors.filter(e => e.severity === 'error')).toHaveLength(0);
  });

  it('reports multiple failures', () => {
    const source = baseMachine.replace('actions {}', `actions {}

properties {
  reachable: idle from failed
  unreachable: completed from idle
}`);
    const result = checkProperties(parseMachine(source));
    expect(result.valid).toBe(false);
    expect(result.errors.filter(e => e.severity === 'error').length).toBe(2);
  });
});

// ---- Integration: Full Example File ----

describe('Payment Processor with Properties', () => {
  it('parses and verifies the payment-with-properties example', () => {
    const source = `
machine PaymentWithProperties

context {
  order_id: string
  amount: decimal
  currency: string
  retry_count: int = 0
  payment_token: string?
  error_message: string?
}

events {
  submit_payment
  payment_authorized
  payment_declined
  payment_timeout
  retry_requested
  cancel_requested
  refund_requested
  settlement_confirmed
}

state idle [initial] {
  description: "Waiting for a payment submission"
  on_entry: -> reset_context
}

state validating {
  description: "Validating payment details"
  on_entry: -> validate_payment_details
}

state authorizing {
  description: "Waiting for gateway response"
  on_entry: -> send_authorization_request
}

state authorized {
  description: "Payment authorized"
  on_entry: -> log_authorization
}

state declined {
  description: "Payment declined"
  on_entry: -> format_decline_reason
}

state failed [final] {
  description: "Terminal failure"
  on_entry: -> record_failure
}

state settled [final] {
  description: "Payment settled"
  on_entry: -> record_settlement
}

guards {
  can_retry: ctx.retry_count < 3
}

transitions {
  idle           + submit_payment        -> validating    : initialize_payment
  validating     + payment_authorized    -> authorizing   : prepare_auth_request
  validating     + payment_declined      -> declined      : _
  authorizing    + payment_authorized    -> authorized    : record_auth_code
  authorizing    + payment_declined      -> declined      : increment_retry
  authorizing    + payment_timeout       -> declined      : set_timeout_error
  declined       + retry_requested [can_retry]   -> validating : increment_retry
  declined       + retry_requested [!can_retry]  -> failed     : set_max_retries_error
  declined       + cancel_requested      -> failed        : _
  authorized     + settlement_confirmed  -> settled       : _
  authorized     + refund_requested      -> failed        : process_refund
}

actions {
  reset_context:             () -> Context
  initialize_payment:        (ctx: Context) -> Context
  validate_payment_details:  (ctx: Context) -> Context
  send_authorization_request: (ctx: Context) -> Context
  prepare_auth_request:      (ctx: Context) -> Context
  record_auth_code:          (ctx: Context) -> Context
  increment_retry:           (ctx: Context) -> Context
  set_timeout_error:         (ctx: Context) -> Context
  set_max_retries_error:     (ctx: Context) -> Context
  format_decline_reason:     (ctx: Context) -> Context
  process_refund:            (ctx: Context) -> Context
  record_failure:            (ctx: Context) -> Context
  log_authorization:         (ctx: Context) -> Context
  record_settlement:         (ctx: Context) -> Context
}

properties {
  # Settlement requires authorization
  passes_through: authorized for idle -> settled

  # Failed payments never settle
  unreachable: settled from failed

  # Authorization is reachable
  reachable: authorized from idle

  # Machine is live
  live

  # Settlement within 5 transitions
  responds: settled from idle within 5

  # Retry bound (advisory)
  invariant: ctx.retry_count <= 3
}`;

    const machine = parseMachine(source);
    expect(machine.properties).toBeDefined();
    expect(machine.properties!.length).toBe(6);

    const result = checkProperties(machine);
    // All topology properties should pass; invariant is advisory warning
    expect(result.valid).toBe(true);
    const errors = result.errors.filter(e => e.severity === 'error');
    expect(errors).toHaveLength(0);
    // Should have the advisory warning for invariant
    expect(result.errors.some(e => e.code === 'PROPERTY_INVARIANT_ADVISORY')).toBe(true);
  });
});
