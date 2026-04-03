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

    it('bare "!" with no value is treated as exact match, not negation', () => {
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
| ! | ok |
`);

      const dt = result.file.decisionTables[0];
      // Bare '!' has no negated value — should fall through to exact match
      expect(dt.rules[0].conditions.get('tier')).toEqual({ kind: 'exact', value: '!' });
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

  describe('numeric range conditions', () => {
    it('parses int_range condition type with domain', () => {
      const result = parseMarkdown(`# decision_table NumericTest

## conditions

| Name | Type | Values |
|------|------|--------|
| score | int_range | 0..100 |

## actions

| Name | Type |
|------|------|
| grade | enum |

## rules

| score | → grade |
|-------|---------|
| 90+ | A |
| 80-89 | B |
| <80 | C |
`);

      const dt = result.file.decisionTables[0];
      expect(dt.conditions).toHaveLength(1);
      expect(dt.conditions[0].type).toBe('int_range');
      expect(dt.conditions[0].range).toEqual({ min: 0, max: 100 });
    });

    it('parses decimal_range condition type with domain', () => {
      const result = parseMarkdown(`# decision_table DecimalTest

## conditions

| Name | Type | Values |
|------|------|--------|
| ratio | decimal_range | 0.0..1.0 |

## actions

| Name | Type |
|------|------|
| level | enum |

## rules

| ratio | → level |
|-------|---------|
| <0.3 | low |
| 0.3-0.7 | medium |
| 0.7+ | high |
`);

      const dt = result.file.decisionTables[0];
      expect(dt.conditions).toHaveLength(1);
      expect(dt.conditions[0].type).toBe('decimal_range');
      expect(dt.conditions[0].range).toEqual({ min: 0.0, max: 1.0 });
    });

    it('parses suffix-plus cell as compare >=', () => {
      const result = parseMarkdown(`# decision_table T

## conditions

| Name | Type | Values |
|------|------|--------|
| x | int_range | 0..100 |

## actions

| Name | Type |
|------|------|
| y | enum |

## rules

| x | → y |
|---|-----|
| 50+ | a |
`);

      const dt = result.file.decisionTables[0];
      const cell = dt.rules[0].conditions.get('x');
      expect(cell).toEqual({ kind: 'compare', op: '>=', value: 50 });
    });

    it('parses comparison operators (<, <=, >, >=)', () => {
      const result = parseMarkdown(`# decision_table T

## conditions

| Name | Type | Values |
|------|------|--------|
| x | decimal_range | 0.0..1.0 |

## actions

| Name | Type |
|------|------|
| y | enum |

## rules

| x | → y |
|---|-----|
| <0.3 | low |
| >=0.7 | high |
| <=0.5 | mid |
| >0.9 | top |
`);

      const dt = result.file.decisionTables[0];
      expect(dt.rules[0].conditions.get('x')).toEqual({ kind: 'compare', op: '<', value: 0.3 });
      expect(dt.rules[1].conditions.get('x')).toEqual({ kind: 'compare', op: '>=', value: 0.7 });
      expect(dt.rules[2].conditions.get('x')).toEqual({ kind: 'compare', op: '<=', value: 0.5 });
      expect(dt.rules[3].conditions.get('x')).toEqual({ kind: 'compare', op: '>', value: 0.9 });
    });

    it('parses dash-separated numeric range', () => {
      const result = parseMarkdown(`# decision_table T

## conditions

| Name | Type | Values |
|------|------|--------|
| score | int_range | 0..100 |

## actions

| Name | Type |
|------|------|
| y | enum |

## rules

| score | → y |
|-------|-----|
| 70-89 | b |
`);

      const dt = result.file.decisionTables[0];
      expect(dt.rules[0].conditions.get('score')).toEqual({
        kind: 'range', low: 70, high: 89, lowInc: true, highInc: true,
      });
    });

    it('parses dot-dot range separator', () => {
      const result = parseMarkdown(`# decision_table T

## conditions

| Name | Type | Values |
|------|------|--------|
| x | int_range | 1..50 |

## actions

| Name | Type |
|------|------|
| y | enum |

## rules

| x | → y |
|---|-----|
| 10..20 | a |
`);

      const dt = result.file.decisionTables[0];
      expect(dt.rules[0].conditions.get('x')).toEqual({
        kind: 'range', low: 10, high: 20, lowInc: true, highInc: true,
      });
    });

    it('parses decimal range with dash separator', () => {
      const result = parseMarkdown(`# decision_table T

## conditions

| Name | Type | Values |
|------|------|--------|
| ratio | decimal_range | 0.0..1.0 |

## actions

| Name | Type |
|------|------|
| y | enum |

## rules

| ratio | → y |
|-------|-----|
| 0.3-0.7 | mid |
`);

      const dt = result.file.decisionTables[0];
      expect(dt.rules[0].conditions.get('ratio')).toEqual({
        kind: 'range', low: 0.3, high: 0.7, lowInc: true, highInc: true,
      });
    });

    it('does not parse numeric patterns for enum conditions', () => {
      const result = parseMarkdown(`# decision_table T

## conditions

| Name | Type | Values |
|------|------|--------|
| tier | enum | 100+, <50 |

## actions

| Name | Type |
|------|------|
| y | enum |

## rules

| tier | → y |
|------|-----|
| 100+ | a |
| <50 | b |
`);

      const dt = result.file.decisionTables[0];
      // Should be parsed as exact string values, not numeric cells
      expect(dt.rules[0].conditions.get('tier')).toEqual({ kind: 'exact', value: '100+' });
      expect(dt.rules[1].conditions.get('tier')).toEqual({ kind: 'exact', value: '<50' });
    });

    it('parses wildcard in numeric columns as any', () => {
      const result = parseMarkdown(`# decision_table T

## conditions

| Name | Type | Values |
|------|------|--------|
| x | int_range | 0..100 |

## actions

| Name | Type |
|------|------|
| y | enum |

## rules

| x | → y |
|---|-----|
| - | a |
`);

      const dt = result.file.decisionTables[0];
      expect(dt.rules[0].conditions.get('x')).toEqual({ kind: 'any' });
    });
  });
});
