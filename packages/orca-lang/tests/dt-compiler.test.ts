import { describe, it, expect } from 'vitest';
import { parseMarkdown } from '../src/parser/markdown-parser.js';
import {
  compileDecisionTableToTypeScript,
  compileDecisionTableToJSON,
  compileDecisionTableToPython,
  compileDecisionTableToGo,
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

  describe('numeric range compilation', () => {
    const numericSrc = `# decision_table RiskScore

## conditions

| Name | Type | Values |
|------|------|--------|
| score | int_range | 0..1000 |
| ratio | decimal_range | 0.0..1.0 |

## actions

| Name | Type |
|------|------|
| tier | enum |

## rules

| score | ratio | → tier |
|-------|-------|--------|
| 750+ | <0.3 | low |
| 600-749 | 0.3-0.5 | medium |
| <600 | - | high |
`;

    it('TypeScript: emits >= for suffix-plus and range checks', () => {
      const result = parseMarkdown(numericSrc);
      const dt = result.file.decisionTables[0];
      const output = compileDecisionTableToTypeScript(dt);

      // score: number type
      expect(output).toContain('score: number');
      expect(output).toContain('ratio: number');

      // Rule 1: score >= 750 && ratio < 0.3
      expect(output).toContain('input.score >= 750');
      expect(output).toContain('input.ratio < 0.3');

      // Rule 2: range check (score >= 600 && score <= 749) && (ratio >= 0.3 && ratio <= 0.5)
      expect(output).toContain('input.score >= 600');
      expect(output).toContain('input.score <= 749');
      expect(output).toContain('input.ratio >= 0.3');
      expect(output).toContain('input.ratio <= 0.5');

      // Rule 3: score < 600
      expect(output).toContain('input.score < 600');
    });

    it('Python: emits correct comparison operators', () => {
      const result = parseMarkdown(numericSrc);
      const dt = result.file.decisionTables[0];
      const output = compileDecisionTableToPython(dt);

      expect(output).toContain('score: int');
      expect(output).toContain('ratio: float');
      expect(output).toContain('input.score >= 750');
      expect(output).toContain('input.ratio < 0.3');
      expect(output).toContain('input.score >= 600 and input.score <= 749');
      expect(output).toContain('input.ratio >= 0.3 and input.ratio <= 0.5');
      expect(output).toContain('input.score < 600');
    });

    it('Go: emits correct comparison operators', () => {
      const result = parseMarkdown(numericSrc);
      const dt = result.file.decisionTables[0];
      const output = compileDecisionTableToGo(dt);

      expect(output).toContain('Score int');
      expect(output).toContain('Ratio float64');
      expect(output).toContain('input.Score >= 750');
      expect(output).toContain('input.Ratio < 0.3');
      expect(output).toContain('input.Score >= 600 && input.Score <= 749');
      expect(output).toContain('input.Ratio >= 0.3 && input.Ratio <= 0.5');
      expect(output).toContain('input.Score < 600');
    });
  });
});
