import { describe, it, expect } from 'vitest';
import { parseMarkdown } from '../src/parser/markdown-parser.js';
import { verifyDecisionTable, verifyDecisionTables } from '../src/verifier/dt-verifier.js';

describe('Decision Table Verifier', () => {
  describe('completeness', () => {
    it('complete table with full coverage passes', () => {
      const result = parseMarkdown(`# decision_table Test

## conditions

| Name | Type | Values |
|------|------|--------|
| tier | enum | low, high |

## actions

| Name | Type |
|------|------|
| discount | enum | none, low, high |

## rules

| tier | → discount |
|------|-----------|
| low | low |
| high | high |
`);
      const dt = result.file.decisionTables[0];
      const verification = verifyDecisionTable(dt);
      expect(verification.valid).toBe(true);
    });

    it('incomplete table (missing combination) fails with DT_INCOMPLETE', () => {
      const result = parseMarkdown(`# decision_table Test

## conditions

| Name | Type | Values |
|------|------|--------|
| tier | enum | low, high |

## actions

| Name | Type |
|------|------|
| discount | enum | none, low, high |

## rules

| tier | → discount |
|------|-----------|
| low | low |
`);
      const dt = result.file.decisionTables[0];
      const verification = verifyDecisionTable(dt);
      expect(verification.valid).toBe(false);
      const incompleteErrors = verification.errors.filter(e => e.code === 'DT_INCOMPLETE');
      expect(incompleteErrors).toHaveLength(1);
      expect(incompleteErrors[0].message).toContain('tier=high');
      expect(incompleteErrors[0].suggestion).toBeDefined();
    });

    it('bool condition with only true rules but missing false coverage is incomplete', () => {
      const result = parseMarkdown(`# decision_table Test

## conditions

| Name | Type | Values |
|------|------|--------|
| is_active | bool | |

## actions

| Name | Type |
|------|------|
| result | enum | ok, error |

## rules

| is_active | → result |
|-----------|----------|
| true | ok |
`);
      const dt = result.file.decisionTables[0];
      const verification = verifyDecisionTable(dt);
      expect(verification.valid).toBe(false);
      expect(verification.errors.some(e => e.code === 'DT_INCOMPLETE')).toBe(true);
    });

    it('wildcard-heavy table (all "-" except one column) passes completeness', () => {
      const result = parseMarkdown(`# decision_table Test

## conditions

| Name | Type | Values |
|------|------|--------|
| tier | enum | low, high |
| region | enum | east, west |

## actions

| Name | Type |
|------|------|
| discount | enum | none |

## rules

| tier | region | → discount |
|------|--------|-----------|
| - | - | none |
`);
      const dt = result.file.decisionTables[0];
      const verification = verifyDecisionTable(dt);
      expect(verification.valid).toBe(true);
    });
  });

  describe('consistency', () => {
    it('inconsistent rules (same input, different output) fails with DT_INCONSISTENT', () => {
      const result = parseMarkdown(`# decision_table Test

## conditions

| Name | Type | Values |
|------|------|--------|
| tier | enum | low, high |

## actions

| Name | Type |
|------|------|
| discount | enum | low, high |

## rules

| tier | → discount |
|------|-----------|
| low | low |
| low | high |
`);
      const dt = result.file.decisionTables[0];
      const verification = verifyDecisionTable(dt);
      expect(verification.valid).toBe(false);
      expect(verification.errors.some(e => e.code === 'DT_INCONSISTENT')).toBe(true);
    });

    it('inconsistent rules with first-match policy produces warning, not error', () => {
      const result = parseMarkdown(`# decision_table Test

## conditions

| Name | Type | Values |
|------|------|--------|
| tier | enum | low, high |

## actions

| Name | Type |
|------|------|
| discount | enum | low, high |

## rules

| tier | → discount |
|------|-----------|
| low | low |
| low | high |
`);
      const dt = result.file.decisionTables[0];
      dt.policy = 'first-match';
      const verification = verifyDecisionTable(dt);
      const inconsistentErrors = verification.errors.filter(e => e.code === 'DT_INCONSISTENT');
      expect(inconsistentErrors).toHaveLength(1);
      expect(inconsistentErrors[0].severity).toBe('warning');
    });

    it('inconsistent rules with all-match policy produces error', () => {
      const result = parseMarkdown(`# decision_table Test

## conditions

| Name | Type | Values |
|------|------|--------|
| tier | enum | low, high |

## actions

| Name | Type |
|------|------|
| discount | enum | low, high |

## rules

| tier | → discount |
|------|-----------|
| low | low |
| low | high |
`);
      const dt = result.file.decisionTables[0];
      dt.policy = 'all-match';
      const verification = verifyDecisionTable(dt);
      const inconsistentErrors = verification.errors.filter(e => e.code === 'DT_INCONSISTENT');
      expect(inconsistentErrors).toHaveLength(1);
      expect(inconsistentErrors[0].severity).toBe('error');
    });

    it('overlapping rules with same actions are consistent', () => {
      const result = parseMarkdown(`# decision_table Test

## conditions

| Name | Type | Values |
|------|------|--------|
| tier | enum | low, high |

## actions

| Name | Type |
|------|------|
| discount | enum | low |

## rules

| tier | → discount |
|------|-----------|
| low | low |
| high | low |
`);
      const dt = result.file.decisionTables[0];
      const verification = verifyDecisionTable(dt);
      // Should not have inconsistency errors (may have redundant warnings)
      const inconsistentErrors = verification.errors.filter(e => e.code === 'DT_INCONSISTENT');
      expect(inconsistentErrors).toHaveLength(0);
    });
  });

  describe('redundancy', () => {
    it('non-overlapping rules with same actions are not flagged as redundant', () => {
      const result = parseMarkdown(`# decision_table Test

## conditions

| Name | Type | Values |
|------|------|--------|
| tier | enum | low, medium, high |

## actions

| Name | Type |
|------|------|
| discount | enum | low, high |

## rules

| tier | → discount |
|------|-----------|
| low | low |
| medium | low |
| high | high |
`);
      const dt = result.file.decisionTables[0];
      const verification = verifyDecisionTable(dt);
      const redundantErrors = verification.errors.filter(e => e.code === 'DT_REDUNDANT');
      expect(redundantErrors).toHaveLength(0);
    });

    it('redundant rule detected with DT_REDUNDANT', () => {
      const result = parseMarkdown(`# decision_table Test

## conditions

| Name | Type | Values |
|------|------|--------|
| tier | enum | low, high |

## actions

| Name | Type |
|------|------|
| discount | enum | low |

## rules

| tier | → discount |
|------|-----------|
| low | low |
| high | low |
`);
      const dt = result.file.decisionTables[0];
      // Add another rule that is redundant since it overlaps with first and has same action
      dt.rules.push({
        conditions: new Map([['tier', { kind: 'exact', value: 'low' }]]),
        actions: new Map([['discount', 'low']]),
      });
      const verification = verifyDecisionTable(dt);
      expect(verification.errors.some(e => e.code === 'DT_REDUNDANT')).toBe(true);
    });
  });

  describe('structural checks', () => {
    it('DT_NO_CONDITIONS error when no conditions declared', () => {
      const result = parseMarkdown(`# decision_table Test

## conditions

## actions

| Name | Type |
|------|------|
| result | enum | ok |

## rules

| → result |
|----------|
| ok |
`);
      const dt = result.file.decisionTables[0];
      const verification = verifyDecisionTable(dt);
      expect(verification.errors.some(e => e.code === 'DT_NO_CONDITIONS')).toBe(true);
    });

    it('DT_NO_ACTIONS error when no actions declared', () => {
      const result = parseMarkdown(`# decision_table Test

## conditions

| Name | Type | Values |
|------|------|--------|
| x | enum | a |

## actions

## rules

| x |
|---|
| a |
`);
      const dt = result.file.decisionTables[0];
      const verification = verifyDecisionTable(dt);
      expect(verification.errors.some(e => e.code === 'DT_NO_ACTIONS')).toBe(true);
    });

    it('DT_EMPTY_RULES warning for empty rules table', () => {
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
`);
      const dt = result.file.decisionTables[0];
      const verification = verifyDecisionTable(dt);
      expect(verification.errors.some(e => e.code === 'DT_EMPTY_RULES')).toBe(true);
    });

    it('DT_UNKNOWN_CONDITION_VALUE caught', () => {
      const result = parseMarkdown(`# decision_table Test

## conditions

| Name | Type | Values |
|------|------|--------|
| tier | enum | low, high |

## actions

| Name | Type |
|------|------|
| discount | enum | low |

## rules

| tier | → discount |
|------|-----------|
| medium | low |
`);
      const dt = result.file.decisionTables[0];
      const verification = verifyDecisionTable(dt);
      expect(verification.errors.some(e => e.code === 'DT_UNKNOWN_CONDITION_VALUE')).toBe(true);
    });

    it('DT_UNKNOWN_ACTION_VALUE caught', () => {
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
| low | medium |
`);
      const dt = result.file.decisionTables[0];
      const verification = verifyDecisionTable(dt);
      expect(verification.errors.some(e => e.code === 'DT_UNKNOWN_ACTION_VALUE')).toBe(true);
    });

    it('DT_MISSING_ACTION_COLUMN when declared action has no rules column', () => {
      const result = parseMarkdown(`# decision_table Test

## conditions

| Name | Type | Values |
|------|------|--------|
| tier | enum | low, high |

## actions

| Name | Type |
|------|------|
| discount | enum | low, high |
| extra | enum | a |

## rules

| tier | → discount |
|------|-----------|
| low | low |
`);
      const dt = result.file.decisionTables[0];
      const verification = verifyDecisionTable(dt);
      expect(verification.errors.some(e => e.code === 'DT_MISSING_ACTION_COLUMN')).toBe(true);
    });

    it('DT_MISSING_CONDITION_COLUMN when declared condition has no rules column', () => {
      const result = parseMarkdown(`# decision_table Test

## conditions

| Name | Type | Values |
|------|------|--------|
| tier | enum | low, high |
| extra | enum | a, b |

## actions

| Name | Type |
|------|------|
| discount | enum | low |

## rules

| tier | → discount |
|------|-----------|
| low | low |
`);
      const dt = result.file.decisionTables[0];
      const verification = verifyDecisionTable(dt);
      expect(verification.errors.some(e => e.code === 'DT_MISSING_CONDITION_COLUMN')).toBe(true);
    });

    it('DT_DUPLICATE_RULE when two rules have identical conditions', () => {
      const result = parseMarkdown(`# decision_table Test

## conditions

| Name | Type | Values |
|------|------|--------|
| tier | enum | low, high |

## actions

| Name | Type |
|------|------|
| discount | enum | low |

## rules

| tier | → discount |
|------|-----------|
| low | low |
| low | low |
`);
      const dt = result.file.decisionTables[0];
      const verification = verifyDecisionTable(dt);
      expect(verification.errors.some(e => e.code === 'DT_DUPLICATE_RULE')).toBe(true);
    });
  });

  describe('large tables', () => {
    it('int_range condition skips completeness with a clear message (not DT_INCOMPLETE)', () => {
      const result = parseMarkdown(`# decision_table Test

## conditions

| Name | Type | Values |
|------|------|--------|
| score | int_range | 300..850 |

## actions

| Name | Type |
|------|------|
| tier | enum | low, high |

## rules

| score | → tier |
|-------|--------|
| 300..649 | low |
| 650..850 | high |
`);
      const dt = result.file.decisionTables[0];
      const verification = verifyDecisionTable(dt);
      expect(verification.errors.some(e => e.code === 'DT_INCOMPLETE')).toBe(false);
      const skipped = verification.errors.find(e => e.code === 'DT_COMPLETENESS_SKIPPED');
      expect(skipped).toBeDefined();
      expect(skipped!.message).toContain('int_range');
    });

    it('large table (> 4096 combinations) gets DT_COMPLETENESS_SKIPPED warning', () => {
      // Create a table with many conditions to exceed 4096 combinations
      // 8 conditions with 4 values each = 4^8 = 65536 > 4096
      const conditions = Array.from({ length: 8 }, (_, i) =>
        `| cond${i} | enum | a, b, c, d |`
      ).join('\n');

      const rules = Array.from({ length: 2 }, (_, i) =>
        `| ${Array(8).fill('-').join(' | ')} | → result |`
      ).join('\n');

      const result = parseMarkdown(`# decision_table Test

## conditions

| Name | Type | Values |
|------|------|--------|
${conditions}

## actions

| Name | Type |
|------|------|
| result | enum | ok |

## rules

${rules}
`);
      const dt = result.file.decisionTables[0];
      const verification = verifyDecisionTable(dt);
      expect(verification.errors.some(e => e.code === 'DT_COMPLETENESS_SKIPPED')).toBe(true);
    });
  });

  describe('verifyDecisionTables', () => {
    it('verifies multiple decision tables', () => {
      const result = parseMarkdown(`# decision_table DT1

## conditions

| Name | Type | Values |
|------|------|--------|
| tier | enum | low |

## actions

| Name | Type |
|------|------|
| discount | enum | low |

## rules

| tier | → discount |
|------|-----------|
| low | low |

---

# decision_table DT2

## conditions

| Name | Type | Values |
|------|------|--------|
| size | enum | small |

## actions

| Name | Type |
|------|------|
| price | enum | low |

## rules

| size | → price |
|-------|--------|
| small | low |
`);
      const verification = verifyDecisionTables(result.file.decisionTables);
      expect(verification.valid).toBe(true);
    });
  });
});
