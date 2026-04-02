import { describe, it, expect } from 'vitest';
import { parseMarkdown } from '../src/parser/markdown-parser.js';
import { verifyDecisionTable, verifyDecisionTables, checkFileContextAlignment, checkDTMachineIntegration } from '../src/verifier/dt-verifier.js';

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

  describe('checkFileContextAlignment (DT_CONTEXT_MISMATCH)', () => {
    const colocatedSource = (conditionName: string, outputName: string) => `
# machine TestMachine

## context

| Field | Type | Default |
|-------|------|---------|
| amount | enum | low, high |
| result | enum | a, b |

## events

- go

## state start [initial]
- ignore: go

## state done [final]

## transitions

| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| start | go | | done | |

---

# decision_table TestDT

## conditions

| Name | Type | Values |
|------|------|--------|
| ${conditionName} | enum | low, high |

## actions

| Name | Type | Values |
|------|------|--------|
| ${outputName} | enum | a, b |

## rules

| ${conditionName} | → ${outputName} |
|------|--------|
| low | a |
| high | b |
`;

    it('passes when all DT condition and output names match machine context', () => {
      const result = parseMarkdown(colocatedSource('amount', 'result'));
      const errors = checkFileContextAlignment(result.file);
      expect(errors).toHaveLength(0);
    });

    it('reports DT_CONTEXT_MISMATCH for unrecognized condition name', () => {
      const result = parseMarkdown(colocatedSource('unknown_cond', 'result'));
      const errors = checkFileContextAlignment(result.file);
      expect(errors.some(e => e.code === 'DT_CONTEXT_MISMATCH')).toBe(true);
      const err = errors.find(e => e.code === 'DT_CONTEXT_MISMATCH');
      expect(err?.location?.condition).toBe('unknown_cond');
    });

    it('reports DT_CONTEXT_MISMATCH for unrecognized output name', () => {
      const result = parseMarkdown(colocatedSource('amount', 'unknown_output'));
      const errors = checkFileContextAlignment(result.file);
      expect(errors.some(e => e.code === 'DT_CONTEXT_MISMATCH')).toBe(true);
      const err = errors.find(e => e.code === 'DT_CONTEXT_MISMATCH');
      expect(err?.location?.action).toBe('unknown_output');
    });

    it('skips alignment check for multi-machine files', () => {
      const multiMachine = `
# machine Machine1

## context

| Field | Type | Default |
|-------|------|---------|
| x | enum | a, b |

## events

- go

## state s1 [initial]
## state s2 [final]

## transitions

| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| s1 | go | | s2 | |

---

# machine Machine2

## context

| Field | Type | Default |
|-------|------|---------|
| y | enum | a, b |

## events

- go

## state s1 [initial]
## state s2 [final]

## transitions

| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| s1 | go | | s2 | |

---

# decision_table SomeDT

## conditions

| Name | Type | Values |
|------|------|--------|
| unrelated_field | enum | a, b |

## actions

| Name | Type | Values |
|------|------|--------|
| another_field | enum | a, b |

## rules

| unrelated_field | → another_field |
|-------|--------|
| a | a |
| b | b |
`;
      const result = parseMarkdown(multiMachine);
      const errors = checkFileContextAlignment(result.file);
      expect(errors).toHaveLength(0);
    });

    it('skips alignment check when no decision tables present', () => {
      const machineOnly = `
# machine TestMachine

## context

| Field | Type | Default |
|-------|------|---------|
| x | enum | a, b |

## events

- go

## state s1 [initial]
## state s2 [final]

## transitions

| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| s1 | go | | s2 | |
`;
      const result = parseMarkdown(machineOnly);
      const errors = checkFileContextAlignment(result.file);
      expect(errors).toHaveLength(0);
    });
  });

  describe('checkDTMachineIntegration', () => {
    // Base source: machine with enum+bool context, fully aligned DT
    const makeSource = (rules: string, guards = '') => `
# machine TestMachine

## context

| Field | Type | Default |
|-------|------|---------|
| tier | enum | low, high |
| urgent | bool | false |
| result | enum | a, b |
| flag | bool | false |

## events

- go

## state start [initial]
- ignore: go

## state done [final]

## transitions

| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| start | go | | done | |

## guards

| Name | Expression |
|------|------------|
${guards}

---

# decision_table TestDT

## conditions

| Name | Type | Values |
|------|------|--------|
| tier | enum | low, high |
| urgent | bool | |

## actions

| Name | Type | Values |
|------|------|--------|
| result | enum | a, b |
| flag | bool | |

## rules

${rules}
`;

    describe('DT_COVERAGE_GAP', () => {
      it('passes when DT covers all machine context combinations', () => {
        const src = makeSource(`
| tier | urgent | → result | → flag |
|------|--------|----------|--------|
| low | true | a | true |
| low | false | a | false |
| high | true | b | true |
| high | false | b | false |
`);
        const errors = checkDTMachineIntegration(parseMarkdown(src).file);
        expect(errors.filter(e => e.code === 'DT_COVERAGE_GAP')).toHaveLength(0);
      });

      it('passes when DT has a catch-all rule', () => {
        const src = makeSource(`
| tier | urgent | → result | → flag |
|------|--------|----------|--------|
| high | true | b | true |
| - | - | a | false |
`);
        const errors = checkDTMachineIntegration(parseMarkdown(src).file);
        expect(errors.filter(e => e.code === 'DT_COVERAGE_GAP')).toHaveLength(0);
      });

      it('reports DT_COVERAGE_GAP when a machine enum value has no matching rule', () => {
        // DT only covers (high, true) and (high, false) — misses both (low, *) cases
        const src = makeSource(`
| tier | urgent | → result | → flag |
|------|--------|----------|--------|
| high | true | b | true |
| high | false | b | false |
`);
        const errors = checkDTMachineIntegration(parseMarkdown(src).file);
        const gaps = errors.filter(e => e.code === 'DT_COVERAGE_GAP');
        expect(gaps.length).toBeGreaterThan(0);
        expect(gaps.some(e => e.message.includes('tier=low'))).toBe(true);
      });

      it('reports DT_COVERAGE_GAP for missing bool branch', () => {
        // Only covers urgent=true, not urgent=false
        const src = makeSource(`
| tier | urgent | → result | → flag |
|------|--------|----------|--------|
| low | true | a | true |
| high | true | b | true |
`);
        const errors = checkDTMachineIntegration(parseMarkdown(src).file);
        const gaps = errors.filter(e => e.code === 'DT_COVERAGE_GAP');
        expect(gaps.length).toBeGreaterThan(0);
        expect(gaps.some(e => e.message.includes('urgent=false'))).toBe(true);
      });

      it('skips DT_COVERAGE_GAP when DT is not aligned with machine context', () => {
        // Unaligned condition name means alignment check would fail, integration skips
        const src = `
# machine M

## context

| Field | Type | Default |
|-------|------|---------|
| tier | enum | low, high |

## events

- go

## state s [initial]
- ignore: go

## state done [final]

## transitions

| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| s | go | | done | |

---

# decision_table D

## conditions

| Name | Type | Values |
|------|------|--------|
| unknown_field | enum | x, y |

## actions

| Name | Type | Values |
|------|------|--------|
| tier | enum | low, high |

## rules

| unknown_field | → tier |
|-------|--------|
| x | low |
| y | high |
`;
        const errors = checkDTMachineIntegration(parseMarkdown(src).file);
        expect(errors.filter(e => e.code === 'DT_COVERAGE_GAP')).toHaveLength(0);
      });
    });

    describe('DT_GUARD_DEAD', () => {
      it('passes when guard compares against a value the DT can produce', () => {
        const src = makeSource(
          `
| tier | urgent | → result | → flag |
|------|--------|----------|--------|
| low | - | a | false |
| high | - | b | true |
`,
          `| check_a | \`ctx.result == 'a'\` |`
        );
        const errors = checkDTMachineIntegration(parseMarkdown(src).file);
        expect(errors.filter(e => e.code === 'DT_GUARD_DEAD')).toHaveLength(0);
      });

      it('reports DT_GUARD_DEAD when guard value is never produced by the DT', () => {
        // DT only outputs result=a or result=b, never result=c
        const src = makeSource(
          `
| tier | urgent | → result | → flag |
|------|--------|----------|--------|
| low | - | a | false |
| high | - | b | true |
`,
          `| impossible | \`ctx.result == 'c'\` |`
        );
        const errors = checkDTMachineIntegration(parseMarkdown(src).file);
        const dead = errors.filter(e => e.code === 'DT_GUARD_DEAD');
        expect(dead.length).toBeGreaterThan(0);
        expect(dead[0].message).toContain("'c'");
        expect(dead[0].message).toContain('result');
      });

      it('does not report DT_GUARD_DEAD for guards on non-DT-output fields', () => {
        // tier is a condition (input), not a DT output
        const src = makeSource(
          `
| tier | urgent | → result | → flag |
|------|--------|----------|--------|
| - | - | a | false |
`,
          `| check_tier | \`ctx.tier == 'low'\` |`
        );
        const errors = checkDTMachineIntegration(parseMarkdown(src).file);
        expect(errors.filter(e => e.code === 'DT_GUARD_DEAD')).toHaveLength(0);
      });

      it('does not report DT_GUARD_DEAD for non-equality operators', () => {
        // lt/gt guards on DT output fields are not checked (too complex to reason about)
        const src = `
# machine M

## context

| Field | Type | Default |
|-------|------|---------|
| score | int | 0 |
| level | enum | low, high |

## events

- go

## state s [initial]
- ignore: go

## state done [final]

## transitions

| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| s | go | | done | |

## guards

| Name | Expression |
|------|------------|
| high_score | \`ctx.score > 100\` |

---

# decision_table D

## conditions

| Name | Type | Values |
|------|------|--------|
| level | enum | low, high |

## actions

| Name | Type | Values |
|------|------|--------|
| score | int | |

## rules

| level | → score |
|-------|---------|
| low | 50 |
| high | 200 |
`;
        const errors = checkDTMachineIntegration(parseMarkdown(src).file);
        expect(errors.filter(e => e.code === 'DT_GUARD_DEAD')).toHaveLength(0);
      });
    });
  });
});
