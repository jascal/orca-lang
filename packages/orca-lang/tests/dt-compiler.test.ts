import { describe, it, expect } from 'vitest';
import { parseMarkdown } from '../src/parser/markdown-parser.js';
import {
  compileDecisionTableToTypeScript,
  compileDecisionTableToJSON,
} from '../src/compiler/dt-compiler.js';

describe('Decision Table Compiler', () => {
  describe('TypeScript output', () => {
    it('generates correct interface types', () => {
      const result = parseMarkdown(`# decision_table PaymentRouting

## conditions

| Name | Type | Values |
|------|------|--------|
| amount_tier | enum | low, medium, high |
| customer_type | enum | new, returning, vip |
| has_fraud_flag | bool | |

## actions

| Name | Type | Values |
|------|------|--------|
| gateway | enum | stripe, adyen, manual_review |
| requires_approval | bool | |
| risk_level | enum | low, medium, high |

## rules

| amount_tier | customer_type | has_fraud_flag | → gateway | → requires_approval | → risk_level |
|-------------|---------------|----------------|-----------|---------------------|--------------|
| high | - | true | manual_review | true | high |
| high | vip | false | stripe | false | low |
`);
      const dt = result.file.decisionTables[0];
      const output = compileDecisionTableToTypeScript(dt);

      // Check input interface
      expect(output).toContain('export interface PaymentRoutingInput {');
      expect(output).toContain("amount_tier: 'low' | 'medium' | 'high';");
      expect(output).toContain("customer_type: 'new' | 'returning' | 'vip';");
      expect(output).toContain('has_fraud_flag: boolean;');

      // Check output interface
      expect(output).toContain('export interface PaymentRoutingOutput {');
      expect(output).toContain("gateway: 'stripe' | 'adyen' | 'manual_review';");
      expect(output).toContain('requires_approval: boolean;');
      expect(output).toContain("risk_level: 'low' | 'medium' | 'high';");

      // Check function name
      expect(output).toContain('export function evaluatePaymentRouting');
    });

    it('enum condition/action with no declared values generates string type', () => {
      const result = parseMarkdown(`# decision_table Test

## conditions

| Name | Type | Values |
|------|------|--------|
| status | enum | |

## actions

| Name | Type |
|------|------|
| result | enum | |

## rules

| status | → result |
|--------|----------|
| active | ok |
`);
      const dt = result.file.decisionTables[0];
      const output = compileDecisionTableToTypeScript(dt);
      // enum with no values should fall back to string, not produce an empty union
      expect(output).toContain('status: string;');
      expect(output).toContain('result: string;');
    });

    it('generates correct output for known inputs', () => {
      const result = parseMarkdown(`# decision_table Test

## conditions

| Name | Type | Values |
|------|------|--------|
| tier | enum | low, high |

## actions

| Name | Type | Values |
|------|------|--------|
| discount | enum | none, low, high |

## rules

| tier | → discount |
|------|-----------|
| low | low |
| high | high |
`);
      const dt = result.file.decisionTables[0];
      const output = compileDecisionTableToTypeScript(dt);

      // Check condition checks
      expect(output).toContain("input.tier === 'low'");
      expect(output).toContain("input.tier === 'high'");
      expect(output).toContain("discount: 'low'");
      expect(output).toContain("discount: 'high'");
    });

    it('wildcard conditions do not generate if-clauses', () => {
      const result = parseMarkdown(`# decision_table Test

## conditions

| Name | Type | Values |
|------|------|--------|
| tier | enum | low, high |
| region | enum | east, west |

## actions

| Name | Type | Values |
|------|------|--------|
| discount | enum | none |

## rules

| tier | region | → discount |
|------|--------|-----------|
| low | - | none |
`);
      const dt = result.file.decisionTables[0];
      const output = compileDecisionTableToTypeScript(dt);

      // Should only have the tier condition check, not region
      expect(output).toContain("input.tier === 'low'");
      // Region should not appear in conditions since it's wildcard
      expect(output).not.toContain('input.region');
    });

    it('bool conditions generate === true / === false', () => {
      const result = parseMarkdown(`# decision_table Test

## conditions

| Name | Type | Values |
|------|------|--------|
| is_active | bool | |

## actions

| Name | Type | Values |
|------|------|--------|
| result | enum | ok |

## rules

| is_active | → result |
|-----------|----------|
| true | ok |
`);
      const dt = result.file.decisionTables[0];
      const output = compileDecisionTableToTypeScript(dt);

      expect(output).toContain('input.is_active === true');
    });

    it('negated conditions generate !==', () => {
      const result = parseMarkdown(`# decision_table Test

## conditions

| Name | Type | Values |
|------|------|--------|
| tier | enum | low, high, vip |

## actions

| Name | Type | Values |
|------|------|--------|
| result | enum | ok |

## rules

| tier | → result |
|------|----------|
| !vip | ok |
`);
      const dt = result.file.decisionTables[0];
      const output = compileDecisionTableToTypeScript(dt);

      expect(output).toContain("input.tier !== 'vip'");
    });

    it('set conditions generate || chains', () => {
      const result = parseMarkdown(`# decision_table Test

## conditions

| Name | Type | Values |
|------|------|--------|
| currency | enum | USD, EUR, GBP |

## actions

| Name | Type | Values |
|------|------|--------|
| result | enum | ok |

## rules

| currency | → result |
|----------|----------|
| USD,EUR | ok |
`);
      const dt = result.file.decisionTables[0];
      const output = compileDecisionTableToTypeScript(dt);

      expect(output).toContain("(input.currency === 'USD' || input.currency === 'EUR')");
    });

    it('function returns null for no match', () => {
      const result = parseMarkdown(`# decision_table Test

## conditions

| Name | Type | Values |
|------|------|--------|
| tier | enum | low, high |

## actions

| Name | Type | Values |
|------|------|--------|
| discount | enum | low |

## rules

| tier | → discount |
|------|-----------|
| low | low |
`);
      const dt = result.file.decisionTables[0];
      const output = compileDecisionTableToTypeScript(dt);

      expect(output).toContain('return null; // no rule matched');
    });

    it('empty rules table generates function that always returns null', () => {
      const result = parseMarkdown(`# decision_table Test

## conditions

| Name | Type | Values |
|------|------|--------|
| tier | enum | low, high |

## actions

| Name | Type | Values |
|------|------|--------|
| discount | enum | low |

## rules

| tier | → discount |
|---|-----|
`);
      const dt = result.file.decisionTables[0];
      const output = compileDecisionTableToTypeScript(dt);

      // Should have input interface
      expect(output).toContain('export interface TestInput {');
      // Should only have return null
      expect(output).toContain('return null; // no rule matched');
      // Should not have any if statements for rules
      expect(output).not.toContain('if (');
    });
  });

  describe('JSON output', () => {
    it('produces valid JSON', () => {
      const result = parseMarkdown(`# decision_table Test

## conditions

| Name | Type | Values |
|------|------|--------|
| tier | enum | low, high |

## actions

| Name | Type | Values |
|------|------|--------|
| discount | enum | low, high |

## rules

| tier | → discount |
|------|-----------|
| low | low |
`);
      const dt = result.file.decisionTables[0];
      const output = compileDecisionTableToJSON(dt);

      expect(() => JSON.parse(output)).not.toThrow();
    });

    it('omits wildcard conditions from rule objects', () => {
      const result = parseMarkdown(`# decision_table Test

## conditions

| Name | Type | Values |
|------|------|--------|
| tier | enum | low, high |
| region | enum | east, west |

## actions

| Name | Type | Values |
|------|------|--------|
| discount | enum | low |

## rules

| tier | region | → discount |
|------|--------|-----------|
| low | - | low |
`);
      const dt = result.file.decisionTables[0];
      const output = compileDecisionTableToJSON(dt);
      const json = JSON.parse(output);

      expect(json.rules[0].conditions).toEqual({ tier: 'low' });
      // region should not be in conditions since it was wildcard
      expect(json.rules[0].conditions.region).toBeUndefined();
    });

    it('includes all required fields', () => {
      const result = parseMarkdown(`# decision_table TestDT

## conditions

| Name | Type | Values |
|------|------|--------|
| tier | enum | low, high |

## actions

| Name | Type | Values |
|------|------|--------|
| discount | enum | low |

## rules

| tier | → discount |
|------|-----------|
| low | low |
`);
      const dt = result.file.decisionTables[0];
      const output = compileDecisionTableToJSON(dt);
      const json = JSON.parse(output);

      expect(json.name).toBe('TestDT');
      expect(json.conditions).toHaveLength(1);
      expect(json.conditions[0].name).toBe('tier');
      expect(json.actions).toHaveLength(1);
      expect(json.actions[0].name).toBe('discount');
      expect(json.rules).toHaveLength(1);
      expect(json.policy).toBe('first-match');
    });
  });
});
