import { describe, it, expect } from 'vitest';
import { parseMarkdown } from '../src/parser/markdown-parser.js';

describe('Decision Table Parser', () => {
  describe('minimal decision table', () => {
    it('parses a simple 1-condition, 1-action, 1-rule table', () => {
      const result = parseMarkdown(`# decision_table SimpleDiscount

## conditions

| Name | Type | Values |
|------|------|--------|
| quantity | enum | small, large |

## actions

| Name | Type | Description |
|------|------|-------------|
| discount | enum | discount percentage |

## rules

| # | quantity | → discount |
|---|----------|------------|
| 1 | small | low |
`);

      expect(result.file.decisionTables).toHaveLength(1);
      const dt = result.file.decisionTables[0];
      expect(dt.name).toBe('SimpleDiscount');
      expect(dt.conditions).toHaveLength(1);
      expect(dt.conditions[0].name).toBe('quantity');
      expect(dt.conditions[0].type).toBe('enum');
      expect(dt.conditions[0].values).toEqual(['small', 'large']);
      expect(dt.actions).toHaveLength(1);
      expect(dt.actions[0].name).toBe('discount');
      expect(dt.rules).toHaveLength(1);
    });
  });

  describe('PaymentRouting example', () => {
    it('parses the full PaymentRouting decision table', () => {
      const result = parseMarkdown(`# decision_table PaymentRouting

Optional prose description of what this table decides.

## conditions

| Name | Type | Values |
|------|------|--------|
| amount_tier | enum | low, medium, high |
| customer_type | enum | new, returning, vip |
| has_fraud_flag | bool | |
| currency | enum | USD, EUR, GBP |

## actions

| Name | Type | Description |
|------|------|-------------|
| gateway | enum | stripe, adyen, manual_review |
| requires_approval | bool | Whether manual approval is needed |
| risk_level | enum | low, medium, high |

## rules

| # | amount_tier | customer_type | has_fraud_flag | currency | → gateway | → requires_approval | → risk_level |
|---|-------------|---------------|----------------|----------|-----------|---------------------|--------------|
| 1 | high | - | true | - | manual_review | true | high |
| 2 | high | vip | false | - | stripe | false | low |
| 3 | high | - | false | - | adyen | true | medium |
| 4 | medium | new | - | - | stripe | true | medium |
| 5 | medium | - | false | - | stripe | false | low |
| 6 | low | - | false | - | stripe | false | low |
| 7 | - | - | true | - | manual_review | true | high |
`);

      expect(result.file.decisionTables).toHaveLength(1);
      const dt = result.file.decisionTables[0];
      expect(dt.name).toBe('PaymentRouting');
      expect(dt.description).toBe('Optional prose description of what this table decides.');
      expect(dt.conditions).toHaveLength(4);
      expect(dt.actions).toHaveLength(3);
      expect(dt.rules).toHaveLength(7);

      // Rule 1: high, any, true, any → manual_review, true, high
      const rule1 = dt.rules[0];
      expect(rule1.number).toBe(1);
      expect(rule1.conditions.get('amount_tier')).toEqual({ kind: 'exact', value: 'high' });
      expect(rule1.conditions.get('customer_type')).toEqual({ kind: 'any' });
      expect(rule1.conditions.get('has_fraud_flag')).toEqual({ kind: 'exact', value: 'true' });
      expect(rule1.conditions.get('currency')).toEqual({ kind: 'any' });
      expect(rule1.actions.get('gateway')).toBe('manual_review');
      expect(rule1.actions.get('requires_approval')).toBe('true');
      expect(rule1.actions.get('risk_level')).toBe('high');
    });
  });

  describe('combined machine + decision table', () => {
    it('parses a file with both machines and decision tables', () => {
      const result = parseMarkdown(`# machine PaymentProcessor

## state idle [initial]
> Waiting for payment

## state completed [final]

## transitions

| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| idle | submit | | completed | |

---

# decision_table PaymentRouting

## conditions

| Name | Type | Values |
|------|------|--------|
| amount_tier | enum | low, high |

## actions

| Name | Type | Description |
|------|------|-------------|
| gateway | enum | stripe, manual |

## rules

| amount_tier | → gateway |
|-------------|-----------|
| low | stripe |
| high | manual |
`);

      expect(result.file.machines).toHaveLength(1);
      expect(result.file.machines[0].name).toBe('PaymentProcessor');
      expect(result.file.decisionTables).toHaveLength(1);
      expect(result.file.decisionTables[0].name).toBe('PaymentRouting');
    });
  });

  describe('cell value parsing', () => {
    it('parses wildcard cells as { kind: "any" }', () => {
      const result = parseMarkdown(`# decision_table Test

## conditions

| Name | Type | Values |
|------|------|--------|
| tier | enum | low, high |

## actions

| Name | Type |
|------|------|
| result | enum | ok |

## rules

| tier | → result |
|------|----------|
| - | ok |
`);

      const dt = result.file.decisionTables[0];
      expect(dt.rules[0].conditions.get('tier')).toEqual({ kind: 'any' });
    });

    it('parses negated cells as { kind: "negated" }', () => {
      const result = parseMarkdown(`# decision_table Test

## conditions

| Name | Type | Values |
|------|------|--------|
| tier | enum | low, high, vip |

## actions

| Name | Type |
|------|------|
| result | enum | ok |

## rules

| tier | → result |
|------|----------|
| !vip | ok |
`);

      const dt = result.file.decisionTables[0];
      expect(dt.rules[0].conditions.get('tier')).toEqual({ kind: 'negated', value: 'vip' });
    });

    it('parses set cells as { kind: "set" }', () => {
      const result = parseMarkdown(`# decision_table Test

## conditions

| Name | Type | Values |
|------|------|--------|
| currency | enum | USD, EUR, GBP |

## actions

| Name | Type |
|------|------|
| result | enum | ok |

## rules

| currency | → result |
|----------|----------|
| USD,EUR | ok |
`);

      const dt = result.file.decisionTables[0];
      expect(dt.rules[0].conditions.get('currency')).toEqual({ kind: 'set', values: ['USD', 'EUR'] });
    });

    it('treats empty cell as wildcard', () => {
      const result = parseMarkdown(`# decision_table Test

## conditions

| Name | Type | Values |
|------|------|--------|
| tier | enum | low, high |

## actions

| Name | Type |
|------|------|
| result | enum | ok |

## rules

| tier | → result |
|------|----------|
| | ok |
`);

      const dt = result.file.decisionTables[0];
      expect(dt.rules[0].conditions.get('tier')).toEqual({ kind: 'any' });
    });
  });

  describe('bool conditions', () => {
    it('auto-populates values with true/false when Values column is empty', () => {
      const result = parseMarkdown(`# decision_table Test

## conditions

| Name | Type | Values |
|------|------|--------|
| is_active | bool | |

## actions

| Name | Type |
|------|------|
| result | enum | ok |

## rules

| is_active | → result |
|-----------|----------|
| true | ok |
`);

      const dt = result.file.decisionTables[0];
      expect(dt.conditions[0].values).toEqual(['true', 'false']);
    });

    it('uses provided values for bool when specified', () => {
      const result = parseMarkdown(`# decision_table Test

## conditions

| Name | Type | Values |
|------|------|--------|
| is_active | bool | enabled, disabled |

## actions

| Name | Type |
|------|------|
| result | enum | ok |

## rules

| is_active | → result |
|-----------|----------|
| enabled | ok |
`);

      const dt = result.file.decisionTables[0];
      expect(dt.conditions[0].values).toEqual(['enabled', 'disabled']);
    });
  });

  describe('description prose', () => {
    it('captures description between H1 and first ##', () => {
      const result = parseMarkdown(`# decision_table TestDT

This is the description prose.
It can span multiple lines.

## conditions

| Name | Type | Values |
|------|------|--------|
| x | enum | a, b |

## actions

| Name | Type |
|------|------|
| y | enum | c |

## rules

| x | → y |
|---|-----|
| a | c |
`);

      const dt = result.file.decisionTables[0];
      expect(dt.description).toBe('This is the description prose.\nIt can span multiple lines.');
    });
  });

  describe('empty rules table', () => {
    it('parses successfully with empty rules array', () => {
      const result = parseMarkdown(`# decision_table EmptyRules

## conditions

| Name | Type | Values |
|------|------|--------|
| x | enum | a, b |

## actions

| Name | Type |
|------|------|
| y | enum | c |

## rules

| x | → y |
|---|-----|
`);

      const dt = result.file.decisionTables[0];
      expect(dt.rules).toHaveLength(0);
    });
  });

  describe('backward compatibility', () => {
    it('machine-only files have empty decisionTables', () => {
      const result = parseMarkdown(`# machine SoloMachine

## state s [initial]

## transitions

| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| s | e | | s | |
`);

      expect(result.file.machines).toHaveLength(1);
      expect(result.file.decisionTables).toHaveLength(0);
    });

    it('multi-machine files have empty decisionTables', () => {
      const result = parseMarkdown(`# machine A

## state s [initial]
## transitions
| s | e | | s | |

---
# machine B

## state s [initial]
## transitions
| s | e | | s | |
`);

      expect(result.file.machines).toHaveLength(2);
      expect(result.file.decisionTables).toHaveLength(0);
    });

    it('decision-table-only file has empty machines', () => {
      const result = parseMarkdown(`# decision_table DT

## conditions

| Name | Type | Values |
|------|------|--------|
| x | enum | a |

## actions

| Name | Type |
|------|------|
| y | enum | b |

## rules

| x | → y |
|---|-----|
| a | b |
`);

      expect(result.file.machines).toHaveLength(0);
      expect(result.file.decisionTables).toHaveLength(1);
    });
  });

  describe('action column prefix', () => {
    it('handles → prefix for action columns', () => {
      const result = parseMarkdown(`# decision_table Test

## conditions

| Name | Type | Values |
|------|------|--------|
| x | enum | a |

## actions

| Name | Type |
|------|------|
| y | enum | b |

## rules

| x | → y |
|---|-----|
| a | b |
`);

      const dt = result.file.decisionTables[0];
      expect(dt.rules[0].actions.get('y')).toBe('b');
    });

    it('handles -> prefix for action columns', () => {
      const result = parseMarkdown(`# decision_table Test

## conditions

| Name | Type | Values |
|------|------|--------|
| x | enum | a |

## actions

| Name | Type |
|------|------|
| y | enum | b |

## rules

| x | -> y |
|----|------|
| a | b |
`);

      const dt = result.file.decisionTables[0];
      expect(dt.rules[0].actions.get('y')).toBe('b');
    });
  });

  describe('policy', () => {
    it('defaults to first-match policy', () => {
      const result = parseMarkdown(`# decision_table Test

## conditions

| Name | Type | Values |
|------|------|--------|
| x | enum | a |

## actions

| Name | Type |
|------|------|
| y | enum | b |

## rules

| x | → y |
|---|-----|
| a | b |
`);

      const dt = result.file.decisionTables[0];
      expect(dt.policy).toBe('first-match');
    });
  });
});
