import { describe, it, expect } from 'vitest';
import { parseMarkdown } from '../src/parser/markdown-parser.js';
import { checkProperties } from '../src/verifier/properties.js';
import { MachineDef, Property } from '../src/parser/ast.js';

// Helper to parse a markdown source and return the machine
function parseMachine(source: string): MachineDef {
  return parseMarkdown(source).machine;
}

// Minimal valid machine for property testing
const baseMachine = `# machine TestMachine

## context

| Field  | Type   | Default |
|--------|--------|---------|
| count  | int    | 0       |
| status | string |         |

## events

- go
- advance
- fail
- retry
- complete

## state idle [initial]
> Start state

## state processing
> Processing

## state validated
> Validated

## state completed [final]
> Done

## state failed [final]
> Failed

## transitions

| Source     | Event   | Target    |
|------------|---------|-----------|
| idle       | go      | processing |
| processing | advance | validated  |
| processing | fail    | failed     |
| validated  | complete| completed  |
| validated  | fail    | failed     |

## actions

| Name | Signature |
|------|----------|
|      |          |
`;

// ---- Parser Tests ----

describe('Property Parser', () => {
  it('parses reachable property', () => {
    const source = baseMachine.replace('## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |', `## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |\n\n## properties\n\n- reachable: completed from idle`);
    const machine = parseMachine(source);
    expect(machine.properties).toBeDefined();
    expect(machine.properties!.length).toBe(1);
    expect(machine.properties![0]).toEqual({ kind: 'reachable', from: 'idle', to: 'completed' });
  });

  it('parses unreachable property', () => {
    const source = baseMachine.replace('## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |', `## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |\n\n## properties\n\n- unreachable: completed from failed`);
    const machine = parseMachine(source);
    expect(machine.properties![0]).toEqual({ kind: 'unreachable', from: 'failed', to: 'completed' });
  });

  it('parses passes_through property', () => {
    const source = baseMachine.replace('## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |', `## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |\n\n## properties\n\n- passes_through: validated for idle -> completed`);
    const machine = parseMachine(source);
    expect(machine.properties![0]).toEqual({
      kind: 'passes_through',
      from: 'idle',
      to: 'completed',
      through: 'validated',
    });
  });

  it('parses live property', () => {
    const source = baseMachine + `\n## properties\n\n- live`;
    const machine = parseMachine(source);
    expect(machine.properties![0]).toEqual({ kind: 'live' });
  });

  it('parses responds property', () => {
    const source = baseMachine.replace('## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |', `## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |\n\n## properties\n\n- responds: completed from idle within 5`);
    const machine = parseMachine(source);
    expect(machine.properties![0]).toEqual({ kind: 'responds', from: 'idle', to: 'completed', within: 5 });
  });

  it('parses invariant property without state', () => {
    const source = baseMachine.replace('## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |', `## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |\n\n## properties\n\n- invariant: \`ctx.count <= 3\``);
    const machine = parseMachine(source);
    expect(machine.properties![0].kind).toBe('invariant');
    const inv = machine.properties![0] as import('../src/parser/ast.js').InvariantProperty;
    expect(inv.inState).toBeUndefined();
    expect(inv.expression.kind).toBe('compare');
  });

  it('parses invariant property with state', () => {
    const source = baseMachine.replace('## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |', `## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |\n\n## properties\n\n- invariant: \`ctx.count < 10\` in processing`);
    const machine = parseMachine(source);
    const inv = machine.properties![0] as import('../src/parser/ast.js').InvariantProperty;
    expect(inv.inState).toBe('processing');
  });

  it('parses multiple properties', () => {
    const source = baseMachine.replace('## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |', `## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |\n\n## properties\n\n- reachable: completed from idle\n- unreachable: completed from failed\n- live\n- responds: completed from idle within 3`);
    const machine = parseMachine(source);
    expect(machine.properties!.length).toBe(4);
    expect(machine.properties![0].kind).toBe('reachable');
    expect(machine.properties![1].kind).toBe('unreachable');
    expect(machine.properties![2].kind).toBe('live');
    expect(machine.properties![3].kind).toBe('responds');
  });

  it('parses dot-notation state names', () => {
    const source = baseMachine.replace('## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |', `## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |\n\n## properties\n\n- reachable: parent.child from root.start`);
    const machine = parseMachine(source);
    const prop = machine.properties![0] as import('../src/parser/ast.js').ReachabilityProperty;
    expect(prop.from).toBe('root.start');
    expect(prop.to).toBe('parent.child');
  });

  it('errors on unknown property type', () => {
    const source = baseMachine.replace('## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |', `## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |\n\n## properties\n\n- bogus: foo`);
    expect(() => parseMachine(source)).toThrow(/Unknown property/i);
  });

  it('machine without properties block has no properties field', () => {
    const machine = parseMachine(baseMachine);
    expect(machine.properties).toBeUndefined();
  });
});

// ---- Reachability Tests ----

describe('Property: reachable', () => {
  it('passes when target is reachable', () => {
    const source = baseMachine.replace('## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |', `## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |\n\n## properties\n\n- reachable: completed from idle`);
    const result = checkProperties(parseMachine(source));
    expect(result.valid).toBe(true);
    expect(result.errors.filter(e => e.severity === 'error')).toHaveLength(0);
  });

  it('fails when target is not reachable', () => {
    const source = baseMachine.replace('## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |', `## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |\n\n## properties\n\n- reachable: idle from failed`);
    const result = checkProperties(parseMachine(source));
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'PROPERTY_REACHABILITY_FAIL')).toBe(true);
  });

  it('errors on invalid state name', () => {
    const source = baseMachine.replace('## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |', `## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |\n\n## properties\n\n- reachable: nonexistent from idle`);
    const result = checkProperties(parseMachine(source));
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'PROPERTY_INVALID_STATE')).toBe(true);
  });
});

// ---- Exclusion Tests ----

describe('Property: unreachable', () => {
  it('passes when target is truly unreachable', () => {
    const source = baseMachine.replace('## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |', `## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |\n\n## properties\n\n- unreachable: completed from failed`);
    const result = checkProperties(parseMachine(source));
    expect(result.valid).toBe(true);
    expect(result.errors.filter(e => e.severity === 'error')).toHaveLength(0);
  });

  it('fails with counterexample when target is reachable', () => {
    const source = baseMachine.replace('## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |', `## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |\n\n## properties\n\n- unreachable: completed from idle`);
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
    const source = baseMachine.replace('## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |', `## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |\n\n## properties\n\n- passes_through: validated for idle -> completed`);
    const result = checkProperties(parseMachine(source));
    expect(result.valid).toBe(true);
  });

  it('passes when intermediate is on every path', () => {
    // idle -> processing is the only way out of idle, so processing is on every path
    const source = baseMachine.replace('## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |', `## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |\n\n## properties\n\n- passes_through: processing for idle -> completed`);
    const result = checkProperties(parseMachine(source));
    expect(result.valid).toBe(true);
  });

  it('fails when a path bypasses the intermediate', () => {
    // Add a shortcut: idle -> completed directly
    const machineWithShortcut = `# machine TestMachine

## context

| Field  | Type   | Default |
|--------|--------|---------|
| count  | int    | 0       |
| status | string |         |

## events

- go
- advance
- fail
- retry
- complete

## state idle [initial]
> Start state

## state processing
> Processing

## state validated
> Validated

## state completed [final]
> Done

## state failed [final]
> Failed

## transitions

| Source     | Event   | Target    |
|------------|---------|-----------|
| idle       | go      | processing |
| processing | advance | validated  |
| processing | fail    | failed     |
| validated  | complete| completed  |
| validated  | fail    | failed     |
| idle       | complete| completed  |

## properties

- passes_through: processing for idle -> completed`;
    const result = checkProperties(parseMachine(machineWithShortcut));
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'PROPERTY_PATH_FAIL')).toBe(true);
  });

  it('fails when target is not reachable at all', () => {
    const source = baseMachine.replace('## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |', `## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |\n\n## properties\n\n- passes_through: processing for failed -> idle`);
    const result = checkProperties(parseMachine(source));
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('not reachable');
  });
});

// ---- Liveness Tests ----

describe('Property: live', () => {
  it('passes when all reachable states can reach a final state', () => {
    const source = baseMachine + `\n## properties\n\n- live`;
    const result = checkProperties(parseMachine(source));
    expect(result.valid).toBe(true);
  });

  it('fails when a reachable state cannot reach any final state', () => {
    // Create a machine with a trap state
    const trapMachine = `# machine TrapMachine

## context

| Field | Type |
|-------|------|
|       |      |

## events

- go
- trap_event

## state start [initial]
> Start state

## state normal
> Normal state

## state trap
> Trap state

## state done [final]
> Done state

## transitions

| Source | Event      | Target |
|--------|------------|--------|
| start  | go         | normal |
| start  | trap_event | trap   |
| normal | go         | done   |

## properties

- live`;
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
    const source = baseMachine.replace('## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |', `## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |\n\n## properties\n\n- responds: completed from idle within 3`);
    const result = checkProperties(parseMachine(source));
    expect(result.valid).toBe(true);
  });

  it('fails when target is beyond the bound', () => {
    // idle -> processing -> validated -> completed = 3 transitions, bound is 2
    const source = baseMachine.replace('## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |', `## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |\n\n## properties\n\n- responds: completed from idle within 2`);
    const result = checkProperties(parseMachine(source));
    expect(result.valid).toBe(false);
    const err = result.errors.find(e => e.code === 'PROPERTY_RESPONSE_FAIL');
    expect(err).toBeDefined();
    expect(err!.message).toContain('reachable beyond 2 transitions');
  });

  it('fails when target is not reachable at all', () => {
    const source = baseMachine.replace('## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |', `## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |\n\n## properties\n\n- responds: idle from failed within 10`);
    const result = checkProperties(parseMachine(source));
    expect(result.valid).toBe(false);
    const err = result.errors.find(e => e.code === 'PROPERTY_RESPONSE_FAIL');
    expect(err!.message).toContain('not reachable at all');
  });
});

// ---- Invariant Tests ----

describe('Property: invariant', () => {
  it('warns as advisory when invariant is valid', () => {
    const source = baseMachine.replace('## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |', `## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |\n\n## properties\n\n- invariant: \`ctx.count <= 3\``);
    const result = checkProperties(parseMachine(source));
    // Should pass (no errors), but have an advisory warning
    expect(result.valid).toBe(true);
    expect(result.errors.some(e => e.code === 'PROPERTY_INVARIANT_ADVISORY')).toBe(true);
  });

  it('errors on undeclared context field', () => {
    const source = baseMachine.replace('## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |', `## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |\n\n## properties\n\n- invariant: \`ctx.nonexistent_field < 5\``);
    const result = checkProperties(parseMachine(source));
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'PROPERTY_INVARIANT_INVALID')).toBe(true);
  });

  it('errors on invalid state reference', () => {
    const source = baseMachine.replace('## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |', `## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |\n\n## properties\n\n- invariant: \`ctx.count < 5\` in nonexistent_state`);
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
    const source = baseMachine.replace('## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |', `## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |\n\n## properties\n\n- reachable: completed from idle\n- unreachable: completed from failed\n- passes_through: processing for idle -> completed\n- live\n- responds: completed from idle within 3`);
    const result = checkProperties(parseMachine(source));
    expect(result.valid).toBe(true);
    expect(result.errors.filter(e => e.severity === 'error')).toHaveLength(0);
  });

  it('reports multiple failures', () => {
    const source = baseMachine.replace('## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |', `## actions\n\n| Name | Signature |\n|------|----------|\n|      |          |\n\n## properties\n\n- reachable: idle from failed\n- unreachable: completed from idle`);
    const result = checkProperties(parseMachine(source));
    expect(result.valid).toBe(false);
    expect(result.errors.filter(e => e.severity === 'error').length).toBe(2);
  });
});

// ---- Integration: Full Example File ----

describe('Payment Processor with Properties', () => {
  it('parses and verifies the payment-with-properties example', () => {
    const source = `# machine PaymentWithProperties

## context

| Field         | Type    | Default |
|---------------|---------|---------|
| order_id      | string  |         |
| amount        | decimal |         |
| currency      | string  |         |
| retry_count   | int     | 0       |
| payment_token | string? |         |
| error_message | string? |         |

## events

- submit_payment
- payment_authorized
- payment_declined
- payment_timeout
- retry_requested
- cancel_requested
- refund_requested
- settlement_confirmed

## state idle [initial]
> Waiting for a payment submission
- on_entry: reset_context

## state validating
> Validating payment details
- on_entry: validate_payment_details

## state authorizing
> Waiting for gateway response
- on_entry: send_authorization_request

## state authorized
> Payment authorized
- on_entry: log_authorization

## state declined
> Payment declined
- on_entry: format_decline_reason

## state failed [final]
> Terminal failure
- on_entry: record_failure

## state settled [final]
> Payment settled
- on_entry: record_settlement

## transitions

| Source      | Event                | Guard      | Target      | Action                |
|-------------|----------------------|------------|-------------|-----------------------|
| idle        | submit_payment       |            | validating  | initialize_payment    |
| validating  | payment_authorized   |            | authorizing | prepare_auth_request  |
| validating  | payment_declined     |            | declined    |                       |
| authorizing | payment_authorized   |            | authorized  | record_auth_code      |
| authorizing | payment_declined     |            | declined    | increment_retry       |
| authorizing | payment_timeout      |            | declined    | set_timeout_error     |
| declined    | retry_requested      | can_retry  | validating  | increment_retry       |
| declined    | retry_requested      | !can_retry | failed      | set_max_retries_error |
| declined    | cancel_requested     |            | failed      |                       |
| authorized  | settlement_confirmed  |            | settled     |                       |
| authorized  | refund_requested     |            | failed      | process_refund        |

## guards

| Name            | Expression                    |
|-----------------|-------------------------------|
| can_retry       | \`ctx.retry_count < 3\`       |
| has_valid_token | \`ctx.payment_token != null\`  |

## actions

| Name                       | Signature                                 |
|----------------------------|-------------------------------------------|
| reset_context              | \`() -> Context\`                         |
| initialize_payment         | \`(ctx, event) -> Context\`               |
| validate_payment_details   | \`(ctx) -> Context\`                       |
| send_authorization_request | \`(ctx) -> Context + Effect<AuthRequest>\` |
| prepare_auth_request       | \`(ctx) -> Context\`                       |
| record_auth_code           | \`(ctx, event) -> Context\`               |
| increment_retry            | \`(ctx) -> Context\`                       |
| set_timeout_error          | \`(ctx) -> Context\`                       |
| set_max_retries_error      | \`(ctx) -> Context\`                       |
| format_decline_reason      | \`(ctx, event) -> Context\`               |
| process_refund             | \`(ctx) -> Context + Effect<RefundRequest>\` |
| record_failure             | \`(ctx) -> Context\`                       |
| log_authorization          | \`(ctx) -> Context\`                       |
| record_settlement          | \`(ctx) -> Context\`                       |

## properties

- passes_through: authorized for idle -> settled
- unreachable: settled from failed
- reachable: authorized from idle
- live
- responds: settled from idle within 5
- invariant: \`ctx.retry_count <= 3\``;

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
