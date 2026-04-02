import { readFileSync } from 'fs';
import { parseMarkdown } from './parser/markdown-parser.js';
import { checkStructural, analyzeFile } from './verifier/structural.js';
import { checkCompleteness } from './verifier/completeness.js';
import { checkDeterminism } from './verifier/determinism.js';
import { checkProperties } from './verifier/properties.js';
import { compileToXState } from './compiler/xstate.js';
import { compileToMermaid } from './compiler/mermaid.js';
import { MachineDef, StateDef, GuardExpression, Type } from './parser/ast.js';
import { DecisionTableDef } from './parser/dt-ast.js';
import { verifyDecisionTable, verifyDecisionTables, checkFileContextAlignment, checkDTMachineIntegration, computeAlignedDTOutputDomain } from './verifier/dt-verifier.js';
import {
  compileDecisionTableToTypeScript,
  compileDecisionTableToPython,
  compileDecisionTableToGo,
  compileDecisionTableToJSON,
  toSnakeCase,
} from './compiler/dt-compiler.js';
import { loadConfig, resolveConfigOverrides } from './config/index.js';
import { createProvider } from './llm/index.js';
import type { LLMProvider } from './llm/index.js';
import { getCodeGenerator } from './generators/index.js';
import { CodeGeneratorType } from './config/types.js';

/** Skill input: provide either a raw source string or a file path (one required). */
export interface SkillInput {
  source?: string;  // raw .orca.md content
  file?: string;    // path to .orca.md file
}

function resolveSource(input: SkillInput): string {
  if (input.source !== undefined) return input.source;
  if (input.file !== undefined) return readFileSync(input.file, 'utf-8');
  throw new Error('SkillInput requires either source or file');
}

function resolveLabel(input: SkillInput): string {
  return input.file ?? '<source>';
}

/** Parse an Orca machine definition (single-machine only). */
function parseSource(label: string, source: string): MachineDef {
  const { file } = parseMarkdown(source);
  if (file.machines.length > 1) {
    throw new Error(`${label} contains multiple machines.`);
  }
  return file.machines[0];
}

export interface SkillError {
  code: string;
  message: string;
  severity: 'error' | 'warning';
  location?: {
    state?: string;
    event?: string;
    transition?: string | { source?: string; target?: string; event?: string }; // string for machine errors, object for DT errors
    // Decision table specific
    rule?: number;
    condition?: string;
    action?: string;
    decisionTable?: string;
  };
  suggestion?: string;
}

export interface VerifySkillResult {
  status: 'valid' | 'invalid';
  machine: string;
  states: number;
  events: number;
  transitions: number;
  errors: SkillError[];
}

export interface CompileSkillResult {
  status: 'success' | 'error';
  target: 'xstate' | 'mermaid';
  output: string;
  warnings: SkillError[];
}

export interface ActionScaffold {
  name: string;
  signature: string;
  parameters: string[];
  returnType: string;
  hasEffect: boolean;
  effectType?: string;
  context_used: string[];
}

export interface GenerateActionsResult {
  status: 'success' | 'error';
  machine: string;
  actions: ActionScaffold[];
  scaffolds: Record<string, string>;
  decisionTableCode?: Record<string, string>;  // DT name → compiled evaluator code
  tests?: Record<string, string>;
}

export interface GenerateOrcaResult {
  status: 'success' | 'error' | 'requires_refinement';
  machine?: string;
  orca?: string;
  verification?: VerifySkillResult;
  error?: string;
}

export interface GenerateMultiResult {
  status: 'success' | 'error' | 'requires_refinement';
  machines?: string[];   // names of all generated machines
  orca?: string;         // full multi-machine .orca.md content
  errors?: SkillError[];
  error?: string;
}

// ── /parse-machine ────────────────────────────────────────────────────────────

export interface ParsedTransition {
  source: string;
  event: string;
  guard?: string;    // human-readable guard expression
  target: string;
  action?: string;
}

export interface ParsedMachine {
  name: string;
  states: string[];
  events: string[];
  transitions: ParsedTransition[];
  guards: { name: string; expression: string }[];
  actions: { name: string; hasEffect: boolean; effectType?: string }[];
  effects?: { name: string; input: string; output: string }[];
  context: { name: string; type: string; default?: string }[];
}

export interface ParseSkillResult {
  status: 'success' | 'error';
  machines?: ParsedMachine[];
  machine?: ParsedMachine;   // first machine; convenience for single-machine files
  error?: string;
}

function collectStateNames(states: StateDef[]): string[] {
  const names: string[] = [];
  for (const s of states) {
    names.push(s.name);
    if (s.contains) names.push(...collectStateNames(s.contains));
    if (s.parallel) {
      for (const region of s.parallel.regions) {
        names.push(...collectStateNames(region.states));
      }
    }
  }
  return names;
}

function serializeType(type: Type): string {
  switch (type.kind) {
    case 'string': return 'string';
    case 'int': return 'int';
    case 'decimal': return 'decimal';
    case 'bool': return 'bool';
    case 'array': return `${type.elementType}[]`;
    case 'map': return `Map<${type.keyType}, ${type.valueType}>`;
    case 'optional': return `${type.innerType}?`;
    case 'custom': return type.name;
  }
}

function serializeGuardExpression(expr: GuardExpression): string {
  switch (expr.kind) {
    case 'true': return 'true';
    case 'false': return 'false';
    case 'not': return `!(${serializeGuardExpression(expr.expr)})`;
    case 'and': return `(${serializeGuardExpression(expr.left)} && ${serializeGuardExpression(expr.right)})`;
    case 'or': return `(${serializeGuardExpression(expr.left)} || ${serializeGuardExpression(expr.right)})`;
    case 'compare': {
      const opMap: Record<string, string> = { eq: '==', ne: '!=', lt: '<', gt: '>', le: '<=', ge: '>=' };
      const leftPath = expr.left.path.join('.');
      const left = leftPath.startsWith('ctx.') ? leftPath : `ctx.${leftPath}`;
      const right = expr.right.type === 'string'
        ? `"${expr.right.value}"`
        : String(expr.right.value);
      return `${left} ${opMap[expr.op]} ${right}`;
    }
    case 'nullcheck': {
      const rawPath = expr.expr.path.join('.');
      const path = rawPath.startsWith('ctx.') ? rawPath : `ctx.${rawPath}`;
      return expr.isNull ? `${path} == null` : `${path} != null`;
    }
  }
}

function machineToParseResult(machine: MachineDef): ParsedMachine {
  return {
    name: machine.name,
    states: collectStateNames(machine.states),
    events: machine.events.map(e => e.name),
    transitions: machine.transitions.map(t => ({
      source: t.source,
      event: t.event,
      guard: t.guard
        ? (t.guard.negated ? `!${t.guard.name}` : t.guard.name)
        : undefined,
      target: t.target,
      action: t.action,
    })),
    guards: machine.guards.map(g => ({
      name: g.name,
      expression: serializeGuardExpression(g.expression),
    })),
    actions: machine.actions.map(a => ({
      name: a.name,
      hasEffect: a.hasEffect,
      effectType: a.effectType,
    })),
    effects: machine.effects?.map(e => ({
      name: e.name,
      input: e.input,
      output: e.output,
    })),
    context: machine.context.map(f => ({
      name: f.name,
      type: serializeType(f.type),
      default: f.defaultValue,
    })),
  };
}

export function parseSkill(input: SkillInput): ParseSkillResult {
  const source = resolveSource(input);
  try {
    const { file } = parseMarkdown(source);
    const machines = file.machines.map(machineToParseResult);
    return {
      status: 'success',
      machines,
      machine: machines[0],
    };
  } catch (err) {
    return {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── /verify-machine ───────────────────────────────────────────────────────────

export async function verifySkill(input: SkillInput): Promise<VerifySkillResult> {
  const source = resolveSource(input);
  const label = resolveLabel(input);

  let machine: MachineDef;
  let fileDecisionTables: import('./parser/dt-ast.js').DecisionTableDef[] = [];
  try {
    const { file } = parseMarkdown(source);
    if (file.machines.length === 0) throw new Error(`${label} contains no machine definition.`);
    if (file.machines.length > 1) throw new Error(`${label} contains multiple machines.`);
    machine = file.machines[0];
    fileDecisionTables = file.decisionTables;
  } catch (err) {
    // Parse error - return as verification error
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 'invalid',
      machine: extractMachineNameFromSource(source) || 'unknown',
      states: 0,
      events: 0,
      transitions: 0,
      errors: [{
        code: 'PARSE_ERROR',
        message,
        severity: 'error',
        suggestion: 'Check Orca syntax - ensure proper formatting for .orca or .orca.md files',
      }],
    };
  }

  const structural = checkStructural(machine);
  const completeness = checkCompleteness(machine);
  const determinism = checkDeterminism(machine);

  // Check co-located decision table alignment and machine integration (single-machine files only)
  const orcaFile = { machines: [machine], decisionTables: fileDecisionTables };
  const dtOutputDomain = fileDecisionTables.length > 0 ? computeAlignedDTOutputDomain(orcaFile) : undefined;
  const properties = checkProperties(machine, { dtOutputDomain });
  const dtAlignment = fileDecisionTables.length > 0
    ? checkFileContextAlignment(orcaFile)
    : [];
  const dtIntegration = fileDecisionTables.length > 0
    ? checkDTMachineIntegration(orcaFile)
    : [];

  const mapError = (e: { code: string; message: string; severity: 'error' | 'warning'; location?: { state?: string; event?: string; decisionTable?: string; condition?: string; action?: string }; suggestion?: string }): SkillError => ({
    code: e.code,
    message: e.message,
    severity: e.severity,
    location: e.location ? {
      state: e.location.state,
      event: e.location.event,
      decisionTable: e.location.decisionTable,
      condition: e.location.condition,
      action: e.location.action,
    } : undefined,
    suggestion: e.suggestion,
  });

  const allErrors: SkillError[] = [
    ...structural.errors.map(mapError),
    ...completeness.errors.map(mapError),
    ...determinism.errors.map(mapError),
    ...properties.errors.map(mapError),
    ...dtAlignment.map(mapError),
    ...dtIntegration.map(mapError),
  ];

  return {
    status: allErrors.some(e => e.severity === 'error') ? 'invalid' : 'valid',
    machine: machine.name,
    states: machine.states.length,
    events: machine.events.length,
    transitions: machine.transitions.length,
    errors: allErrors,
  };
}

export async function compileSkill(input: SkillInput, target: 'xstate' | 'mermaid'): Promise<CompileSkillResult> {
  const source = resolveSource(input);
  const machine = parseSource(resolveLabel(input), source);

  // Run verification to get warnings
  const structural = checkStructural(machine);
  const completeness = checkCompleteness(machine);
  const determinism = checkDeterminism(machine);

  const warnings: SkillError[] = [
    ...structural.errors.filter(e => e.severity === 'warning').map(e => ({
      code: e.code,
      message: e.message,
      severity: e.severity as 'error' | 'warning',
    })),
    ...completeness.errors.filter(e => e.severity === 'warning').map(e => ({
      code: e.code,
      message: e.message,
      severity: e.severity as 'error' | 'warning',
    })),
    ...determinism.errors.filter(e => e.severity === 'warning').map(e => ({
      code: e.code,
      message: e.message,
      severity: e.severity as 'error' | 'warning',
    })),
  ];

  const output = target === 'xstate'
    ? compileToXState(machine)
    : compileToMermaid(machine);

  return {
    status: 'success',
    target,
    output,
    warnings,
  };
}

export async function generateActionsSkill(
  input: SkillInput,
  language: string = 'typescript',
  useLLM: boolean = false,
  configPath?: string,
  generateTests: boolean = false
): Promise<GenerateActionsResult> {
  const source = resolveSource(input);

  // Parse the full file to get both the machine and any co-located decision tables
  const { file } = parseMarkdown(source);
  const label = resolveLabel(input);
  if (file.machines.length === 0) {
    throw new Error(`${label} contains no machine definition.`);
  }
  if (file.machines.length > 1) {
    throw new Error(`${label} contains multiple machines. Use a single-machine file for action generation.`);
  }
  const machine = file.machines[0];
  const decisionTables = file.decisionTables;

  const actions: ActionScaffold[] = machine.actions.map(action => ({
    name: action.name,
    signature: `${action.name}(${action.parameters.join(', ')}) -> ${action.returnType}${action.hasEffect ? ` + Effect<${action.effectType}>` : ''}`,
    parameters: action.parameters,
    returnType: action.returnType,
    hasEffect: action.hasEffect,
    effectType: action.effectType,
    context_used: extractContextFields(machine, action.name),
  }));

  // Compile decision table evaluator code for each DT in the file
  const decisionTableCode: Record<string, string> = {};
  for (const dt of decisionTables) {
    if (language === 'python') {
      decisionTableCode[dt.name] = compileDecisionTableToPython(dt);
    } else if (language === 'go') {
      decisionTableCode[dt.name] = compileDecisionTableToGo(dt);
    } else {
      decisionTableCode[dt.name] = compileDecisionTableToTypeScript(dt);
    }
  }

  let scaffolds: Record<string, string> = {};
  let tests: Record<string, string> = {};

  if (useLLM) {
    // Use LLM to generate action implementations
    const config = loadConfig(configPath);
    const provider = createProvider(config.provider, {
      api_key: config.api_key,
      base_url: config.base_url,
      model: config.model,
      max_tokens: config.max_tokens,
      temperature: config.temperature,
    });

    scaffolds = await generateWithLLM(provider, actions, machine, language as CodeGeneratorType, decisionTables);

    if (generateTests) {
      tests = await generateUnitTests(provider, actions, machine, language as CodeGeneratorType);
    }
  } else {
    // Use template-based scaffold generation
    for (const action of machine.actions) {
      const matchedDT = findMatchingDT(action.name, decisionTables);
      if (matchedDT && !action.hasEffect && isDTFullyAligned(matchedDT, machine)) {
        // All DT conditions and outputs exist in context — generate fully wired code
        scaffolds[action.name] = generateFullyWiredActionScaffold(action, machine, language, matchedDT);
      } else {
        scaffolds[action.name] = generateActionScaffold(action, machine, language, matchedDT ?? undefined);
      }
    }

    if (generateTests) {
      tests = generateTemplateTests(actions, machine, language);
    }
  }

  return {
    status: 'success',
    machine: machine.name,
    actions,
    scaffolds,
    decisionTableCode: Object.keys(decisionTableCode).length > 0 ? decisionTableCode : undefined,
    tests: Object.keys(tests).length > 0 ? tests : undefined,
  };
}

async function generateWithLLM(
  provider: LLMProvider,
  actions: ActionScaffold[],
  machine: MachineDef,
  language: CodeGeneratorType,
  decisionTables: DecisionTableDef[] = []
): Promise<Record<string, string>> {
  const generator = getCodeGenerator(language);
  const scaffolds: Record<string, string> = {};

  const dtContext = decisionTables.length > 0
    ? `\nDecision tables available:\n${decisionTables.map(dt =>
        `- ${dt.name}: conditions=[${dt.conditions.map(c => c.name).join(', ')}] outputs=[${dt.actions.map(a => a.name).join(', ')}]`
      ).join('\n')}`
    : '';

  const systemPrompt = `You are an expert ${language} developer specializing in state machine action implementations.
Given a machine definition and action signatures, generate complete action implementations.
Follow the type signatures exactly. Use the provided context fields.
If an action has an effect, return [newContext, effect] tuple.
If decision tables are listed, use their evaluator functions (e.g. evaluate${language === 'go' ? 'DtName' : 'DtName'}) when appropriate.`;

  for (const action of actions) {
    const matchedDT = findMatchingDT(action.name, decisionTables);
    const dtHint = matchedDT
      ? `\nThis action should use the ${matchedDT.name} decision table evaluator.`
      : '';

    const userPrompt = `Machine: ${machine.name}
Context fields: ${machine.context.map(f => `${f.name}: ${f.type || 'unknown'}`).join(', ')}${dtContext}

Action: ${action.signature}
Description: ${action.name}${action.hasEffect ? ` (effect type: ${action.effectType})` : ''}${dtHint}

Generate the implementation:`;

    try {
      const response = await provider.complete({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        model: '',
        max_tokens: 2048,
        temperature: 0.5,
      });

      scaffolds[action.name] = response.content;
    } catch (err) {
      console.error(`LLM error for action ${action.name}: ${err instanceof Error ? err.message : String(err)}`);
      // Fall back to scaffold on error
      scaffolds[action.name] = generateActionScaffold(action, machine, language, matchedDT ?? undefined);
    }
  }

  return scaffolds;
}

async function generateUnitTests(
  provider: LLMProvider,
  actions: ActionScaffold[],
  machine: MachineDef,
  language: CodeGeneratorType
): Promise<Record<string, string>> {
  const tests: Record<string, string> = {};

  const systemPrompt = `You are an expert in ${language} testing. Generate unit tests for state machine actions.
Each test should verify the action's behavior with specific input contexts.
Use a testing framework appropriate for ${language}.`;

  for (const action of actions) {
    const contextFields = machine.context.map(f => `${f.name}: ${f.type || 'unknown'}`).join(', ');

    const userPrompt = `Machine: ${machine.name}
Context type: { ${contextFields} }
Action: ${action.signature}
Context fields used: ${action.context_used.join(', ') || 'all fields'}

Generate unit tests that verify:
1. The action transforms context correctly
2. All context fields are preserved (if not modified)
3. Edge cases for the specific action

Format: Provide test code in a code fence.`;

    try {
      const response = await provider.complete({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        model: '',
        max_tokens: 2048,
        temperature: 0.3,
      });

      tests[action.name] = response.content;
    } catch (err) {
      console.error(`Test generation error for action ${action.name}: ${err instanceof Error ? err.message : String(err)}`);
      // Fall back to template tests on error
      tests[action.name] = generateTemplateTestsForAction(action, machine);
    }
  }

  return tests;
}

function generateTemplateTests(actions: ActionScaffold[], machine: MachineDef, language: string = 'typescript'): Record<string, string> {
  const tests: Record<string, string> = {};
  for (const action of actions) {
    tests[action.name] = generateTemplateTestsForAction(action, machine, language);
  }
  return tests;
}

function generateTemplateTestsForAction(action: ActionScaffold, machine: MachineDef, language: string = 'typescript'): string {
  if (language === 'python') {
    return generatePythonTestScaffold(action, machine);
  }
  if (language === 'go') {
    return generateGoTestScaffold(action, machine);
  }
  return generateTypeScriptTestScaffold(action, machine);
}

function generateTypeScriptTestScaffold(action: ActionScaffold, machine: MachineDef): string {
  const ctxFields = machine.context.map(f => {
    return `    ${f.name}: ${getDefaultValueForType(f.type, 'typescript')}`;
  }).join(',\n');
  const contextUsed = action.context_used.length > 0 ? action.context_used : machine.context.map(f => f.name);

  if (action.hasEffect) {
    return `// Tests for ${action.name}
describe('${action.name}', () => {
  const defaultContext = {
${ctxFields}
  };

  it('should return updated context and emit effect', () => {
    const ctx = { ...defaultContext };
    const result = ${action.name}(ctx);

    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);
    expect(result[1]).toHaveProperty('type');
    expect(result[1].type).toBe('${action.effectType}');
  });

  it('should preserve unmodified context fields', () => {
    const ctx = { ...defaultContext };
    const [newCtx] = ${action.name}(ctx);

    ${contextUsed.filter(f => !actionModifiesField(action, f)).map(f =>
      `expect(newCtx.${f}).toBe(ctx.${f});`
    ).join('\n    ')}
  });
});
`;
  }

  return `// Tests for ${action.name}
describe('${action.name}', () => {
  const defaultContext = {
${ctxFields}
  };

  it('should transform context correctly', () => {
    const ctx = { ...defaultContext };
    const result = ${action.name}(ctx);

    expect(result).toBeDefined();
    expect(typeof result).toBe('object');
  });

  it('should preserve unmodified context fields', () => {
    const ctx = { ...defaultContext };
    const result = ${action.name}(ctx);

    ${contextUsed.filter(f => !actionModifiesField(action, f)).map(f =>
      `expect(result.${f}).toBe(ctx.${f});`
    ).join('\n    ')}
  });
});
`;
}

function generatePythonTestScaffold(action: ActionScaffold, machine: MachineDef): string {
  const ctxFields = machine.context.map(f => {
    return `        "${f.name}": ${getDefaultValueForType(f.type, 'python')}`;
  }).join(',\n');
  const contextUsed = action.context_used.length > 0 ? action.context_used : machine.context.map(f => f.name);
  const preserved = contextUsed.filter(f => !actionModifiesField(action, f));

  if (action.hasEffect) {
    return `# Tests for ${action.name}
import pytest
from orca_runtime_python import Effect, EffectResult, EffectStatus


def make_context():
    return {
${ctxFields}
    }


@pytest.mark.asyncio
async def test_${action.name}_executes_effect():
    effect = Effect(
        type="${action.effectType}",
        payload={"action": "${action.name}", "context": make_context(), "event": None},
    )
    result = await ${action.name}(effect)
    assert result.status == EffectStatus.SUCCESS


@pytest.mark.asyncio
async def test_${action.name}_returns_effect_result():
    effect = Effect(
        type="${action.effectType}",
        payload={"action": "${action.name}", "context": make_context(), "event": None},
    )
    result = await ${action.name}(effect)
    assert isinstance(result, EffectResult)
`;
  }

  return `# Tests for ${action.name}
import pytest


def make_context():
    return {
${ctxFields}
    }


@pytest.mark.asyncio
async def test_${action.name}_transforms_context():
    ctx = make_context()
    result = await ${action.name}(ctx)
    assert isinstance(result, dict)


@pytest.mark.asyncio
async def test_${action.name}_preserves_fields():
    ctx = make_context()
    result = await ${action.name}(ctx)
${preserved.map(f => `    assert result["${f}"] == ctx["${f}"]`).join('\n')}
`;
}

function generateGoTestScaffold(action: ActionScaffold, machine: MachineDef): string {
  const fnName = toPascalCase(action.name);
  const ctxFields = machine.context.map(f => {
    return `\t\t"${f.name}": ${getDefaultValueForType(f.type, 'go')}`;
  }).join(',\n');
  const contextUsed = action.context_used.length > 0 ? action.context_used : machine.context.map(f => f.name);
  const preserved = contextUsed.filter(f => !actionModifiesField(action, f));

  if (action.hasEffect) {
    return `// Tests for ${action.name}
package actions_test

import (
\t"testing"
\torca "github.com/jascal/orca-lang/packages/runtime-go/orca_runtime_go"
)

func Test${fnName}(t *testing.T) {
\tctx := orca.Context{
${ctxFields},
\t}
\teffect := orca.Effect{
\t\tType:    "${action.effectType}",
\t\tPayload: map[string]any{"action": "${action.name}", "context": ctx},
\t}
\tresult := ${fnName}(effect)
\tif result.Status != orca.EffectStatusSuccess {
\t\tt.Errorf("expected success, got %v: %s", result.Status, result.Error)
\t}
}
`;
  }

  return `// Tests for ${action.name}
package actions_test

import (
\t"testing"
\torca "github.com/jascal/orca-lang/packages/runtime-go/orca_runtime_go"
)

func Test${fnName}(t *testing.T) {
\tctx := orca.Context{
${ctxFields},
\t}
\tevent := map[string]any{"type": "test"}
\tresult := ${fnName}(ctx, event)
\tif result == nil {
\t\tt.Fatal("${fnName} returned nil context")
\t}
${preserved.map(f => `\tif result["${f}"] != ctx["${f}"] {\n\t\tt.Errorf("${f}: got %v, want %v", result["${f}"], ctx["${f}"])\n\t}`).join('\n')}
}
`;
}

function actionModifiesField(action: ActionScaffold, fieldName: string): boolean {
  // Heuristic: if the action name suggests modification of a field, it likely modifies it
  const modifiers = ['increment', 'decrement', 'set', 'update', 'add', 'remove', 'clear', 'reset', 'toggle'];
  const name = action.name.toLowerCase();

  for (const mod of modifiers) {
    if (name.includes(mod) && name.includes(fieldName)) {
      return true;
    }
  }

  // Check if it's a setter-style action
  if (name.startsWith('set_') && fieldName === name.replace('set_', '')) {
    return true;
  }

  return false;
}

function getDefaultValueForType(type: any, language: string = 'typescript'): string {
  if (!type) {
    return language === 'python' ? '""' : language === 'go' ? '""' : "''";
  }
  if (typeof type === 'object' && 'kind' in type) {
    if (language === 'python') {
      switch (type.kind) {
        case 'string': return '""';
        case 'int': return '0';
        case 'decimal': return '0.0';
        case 'bool': return 'False';
        case 'optional': return 'None';
        case 'array': return '[]';
        case 'map': return '{}';
        case 'custom': return 'None';
      }
    } else if (language === 'go') {
      switch (type.kind) {
        case 'string': return '""';
        case 'int': return '0';
        case 'decimal': return '0.0';
        case 'bool': return 'false';
        case 'optional': return 'nil';
        case 'array': return 'nil';
        case 'map': return 'nil';
        case 'custom': return 'nil';
      }
    } else {
      switch (type.kind) {
        case 'string': return "''";
        case 'int':
        case 'decimal': return '0';
        case 'bool': return 'false';
        case 'optional': return 'null';
        case 'array': return '[]';
        case 'map': return '{}';
        case 'custom': return 'null';
      }
    }
  }
  return language === 'python' ? 'None' : language === 'go' ? 'nil' : 'null';
}

function extractContextFields(machine: MachineDef, actionName: string): string[] {
  const fields: string[] = [];

  // Check transitions for context usage
  for (const t of machine.transitions) {
    if (t.action === actionName) {
      // In a real implementation, this would analyze the guard expressions
      // For now, just return all context fields
      return machine.context.map(f => f.name);
    }
  }

  // Check on_entry/on_exit
  for (const state of machine.states) {
    if (state.onEntry === actionName || state.onExit === actionName) {
      return machine.context.map(f => f.name);
    }
  }

  return fields;
}

function toPascalCase(snake: string): string {
  return snake.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
}

/**
 * Find a decision table whose name tokens overlap with the action name tokens.
 * E.g. action "apply_routing_decision" matches DT "PaymentRouting" via "routing".
 */
function findMatchingDT(actionName: string, dts: DecisionTableDef[]): DecisionTableDef | null {
  if (dts.length === 0) return null;
  const actionTokens = new Set(
    actionName.toLowerCase().split('_').filter(t => t.length > 2)
  );
  for (const dt of dts) {
    const dtTokens = dt.name
      .replace(/([A-Z])/g, ' $1')
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(t => t.length > 2);
    if (dtTokens.some(t => actionTokens.has(t))) return dt;
  }
  return null;
}

/**
 * Generate a commented example DT call block to include in an action stub.
 */
function generateDTCallComment(dt: DecisionTableDef, language: string): string {
  const dtName = dt.name;

  if (language === 'python') {
    const fnName = `evaluate_${toSnakeCase(dtName)}`;
    const inputClass = `${toPascalCase(dtName)}Input`;
    const inputArgs = dt.conditions.map(c => {
      const hint = c.type === 'enum' && c.values.length > 0
        ? `str (${c.values.join(', ')})`
        : c.type === 'bool' ? 'bool' : 'str';
      return `    #     ${c.name}=...,  # ${hint} — map from ctx`;
    }).join('\n');
    const outputFields = dt.actions.map(a =>
      `    #     # dt_result.${a.name} → ctx['${a.name}']`
    ).join('\n');
    return [
      `    # Call ${fnName} to evaluate ${dtName} rules:`,
      `    # dt_result = ${fnName}(${inputClass}(`,
      inputArgs,
      `    # ))`,
      `    # if dt_result is not None:`,
      outputFields,
    ].join('\n');
  }

  if (language === 'go') {
    const fnName = `Evaluate${toPascalCase(dtName)}`;
    const inputStruct = `${toPascalCase(dtName)}Input`;
    const inputArgs = dt.conditions.map(c => {
      const goField = toPascalCase(c.name);
      const hint = c.type === 'enum' && c.values.length > 0
        ? `string (${c.values.join(', ')})`
        : c.type === 'bool' ? 'bool' : 'string';
      return `\t// \t${goField}: ..., // ${hint} — map from ctx`;
    }).join('\n');
    const outputFields = dt.actions.map(a =>
      `\t// \tresult["${a.name}"] = dtResult.${toPascalCase(a.name)}`
    ).join('\n');
    return [
      `\t// Call ${fnName} to evaluate ${dtName} rules:`,
      `\t// dtResult := ${fnName}(${inputStruct}{`,
      inputArgs,
      `\t// })`,
      `\t// if dtResult != nil {`,
      outputFields,
      `\t// }`,
    ].join('\n');
  }

  // TypeScript (default)
  const fnName = `evaluate${toPascalCase(dtName)}`;
  const inputType = `${toPascalCase(dtName)}Input`;
  const inputArgs = dt.conditions.map(c => {
    const hint = c.type === 'enum' && c.values.length > 0
      ? `enum: ${c.values.join(', ')}`
      : c.type;
    return `  //   ${c.name}: /* ctx.? */ as ${inputType}['${c.name}'],  // ${hint} — map from ctx`;
  }).join('\n');
  const outputFields = dt.actions.map(a =>
    `  //   ${a.name}: dtResult.${a.name},`
  ).join('\n');
  return [
    `  // Call ${fnName} to evaluate ${dtName} rules:`,
    `  // const dtResult = ${fnName}({`,
    inputArgs,
    `  // });`,
    `  // if (dtResult !== null) {`,
    `  //   return { ...ctx,`,
    outputFields,
    `  //   };`,
    `  // }`,
  ].join('\n');
}

/**
 * Returns true when every DT condition name and output name exists as a
 * context field in the machine — the full co-location contract is satisfied.
 */
function isDTFullyAligned(dt: DecisionTableDef, machine: MachineDef): boolean {
  const contextNames = new Set(machine.context.map(f => f.name));
  return dt.conditions.every(c => contextNames.has(c.name)) &&
         dt.actions.every(a => contextNames.has(a.name));
}

/** Generate a Go type assertion for reading a context value. */
function goCtxRead(fieldName: string, condType: string): string {
  if (condType === 'bool') return `ctx["${fieldName}"].(bool)`;
  if (condType === 'int_range') return `ctx["${fieldName}"].(int)`;
  return `ctx["${fieldName}"].(string)`;
}

function generateFullyWiredActionScaffold(
  action: { name: string; parameters: string[]; returnType: string; hasEffect: boolean; effectType?: string },
  machine: MachineDef,
  language: string,
  dt: DecisionTableDef
): string {
  if (language === 'python') {
    const dtFnName = `evaluate_${toSnakeCase(dt.name)}`;
    const inputClass = `${toPascalCase(dt.name)}Input`;
    const inputArgs = dt.conditions
      .map(c => `        ${c.name}=ctx['${c.name}'],`)
      .join('\n');
    const outputAssigns = dt.actions
      .map(a => `            '${a.name}': dt_result.${a.name},`)
      .join('\n');
    return `# Action: ${action.name}
# Decision table: ${dt.name}
# Register via: machine.register_action("${action.name}", ${action.name})

from typing import Any

async def ${action.name}(ctx: dict[str, Any], event: Any = None) -> dict[str, Any]:
    dt_result = ${dtFnName}(${inputClass}(
${inputArgs}
    ))
    if dt_result is not None:
        return {**ctx,
${outputAssigns}
        }
    return dict(ctx)
`;
  }

  if (language === 'go') {
    const fnName = toPascalCase(action.name);
    const dtFnName = `Evaluate${toPascalCase(dt.name)}`;
    const inputStruct = `${toPascalCase(dt.name)}Input`;
    const ctxReads = dt.conditions.map(c => {
      const varName = toPascalCase(c.name).charAt(0).toLowerCase() + toPascalCase(c.name).slice(1);
      return `\t${varName}, _ := ${goCtxRead(c.name, c.type)}`;
    }).join('\n');
    const inputFields = dt.conditions.map(c => {
      const goField = toPascalCase(c.name);
      const varName = goField.charAt(0).toLowerCase() + goField.slice(1);
      return `\t\t${goField}: ${varName},`;
    }).join('\n');
    const outputAssigns = dt.actions
      .map(a => `\t\tresult["${a.name}"] = dtResult.${toPascalCase(a.name)}`)
      .join('\n');
    return `// Action: ${action.name}
// Decision table: ${dt.name}
// Register via: machine.RegisterAction("${action.name}", ${fnName})

func ${fnName}(ctx orca.Context, event map[string]any) map[string]any {
${ctxReads}
\tdtResult := ${dtFnName}(${inputStruct}{
${inputFields}
\t})
\tresult := make(orca.Context)
\tfor k, v := range ctx {
\t\tresult[k] = v
\t}
\tif dtResult != nil {
${outputAssigns}
\t}
\treturn result
}
`;
  }

  // TypeScript (default)
  const dtFnName = `evaluate${toPascalCase(dt.name)}`;
  const inputArgs = dt.conditions
    .map(c => `    ${c.name}: ctx.${c.name},`)
    .join('\n');
  const outputAssigns = dt.actions
    .map(a => `      ${a.name}: dtResult.${a.name},`)
    .join('\n');
  return `// Action: ${action.name}
// Decision table: ${dt.name}

export function ${action.name}(ctx: Context): Context {
  const dtResult = ${dtFnName}({
${inputArgs}
  });
  if (dtResult !== null) {
    return {
      ...ctx,
${outputAssigns}
    };
  }
  return { ...ctx };
}
`;
}

function generateActionScaffold(
  action: { name: string; parameters: string[]; returnType: string; hasEffect: boolean; effectType?: string },
  machine: MachineDef,
  language: string,
  matchedDT?: DecisionTableDef
): string {
  if (language === 'python') {
    if (action.hasEffect) {
      return `# Action: ${action.name}
# Effect: ${action.effectType}
# Register via: bus.register_effect_handler("${action.effectType}", ${action.name})

from typing import Any
from orca_runtime_python import Effect, EffectResult, EffectStatus

async def ${action.name}(effect: Effect) -> EffectResult:
    # effect.payload contains {"action": "${action.name}", "context": {...}, "event": None}
    ctx = effect.payload.get("context", {})
    # TODO: Implement effect
    return EffectResult(status=EffectStatus.SUCCESS, data={})
`;
    }
    const pyDTComment = matchedDT ? '\n' + generateDTCallComment(matchedDT, 'python') + '\n' : '';
    const pyTodo = matchedDT
      ? `    # TODO: Implement action using ${matchedDT.name} decision table`
      : '    # TODO: Implement action';
    return `# Action: ${action.name}${matchedDT ? `\n# Decision table: ${matchedDT.name}` : ''}
# Register via: machine.register_action("${action.name}", ${action.name})

from typing import Any

async def ${action.name}(ctx: dict[str, Any], event: Any = None) -> dict[str, Any]:${pyDTComment}
${pyTodo}
    return dict(ctx)
`;
  }

  if (language === 'go') {
    const fnName = toPascalCase(action.name);
    if (action.hasEffect) {
      return `// Action: ${action.name}
// Effect: ${action.effectType}
// Register via: bus.SetEffectHandler(DispatchEffects)
// Add a case for "${action.effectType}" in your effect dispatcher.

func ${fnName}(effect orca.Effect) orca.EffectResult {
\t// effect.Type == "${action.effectType}"
\t// effect.Payload contains {"action": "${action.name}", "context": map[string]any{...}}
\t// TODO: Implement effect
\treturn orca.EffectResult{Status: orca.EffectStatusSuccess, Data: map[string]any{}}
}
`;
    }
    const goDTComment = matchedDT ? '\n' + generateDTCallComment(matchedDT, 'go') + '\n' : '';
    const goTodo = matchedDT
      ? `\t// TODO: Implement action using ${matchedDT.name} decision table`
      : '\t// TODO: Implement action';
    return `// Action: ${action.name}${matchedDT ? `\n// Decision table: ${matchedDT.name}` : ''}
// Register via: machine.RegisterAction("${action.name}", ${fnName})

func ${fnName}(ctx orca.Context, event map[string]any) map[string]any {${goDTComment}
${goTodo}
\tresult := make(orca.Context)
\tfor k, v := range ctx {
\t\tresult[k] = v
\t}
\treturn result
}
`;
  }

  // TypeScript (default)
  const params = action.parameters.map(p => {
    if (p === 'ctx' || p === 'Context') return 'ctx: Context';
    if (p.startsWith('event:')) return p;
    return `ctx: Context, ${p}`;
  }).join(', ');

  if (action.hasEffect) {
    return `// Action: ${action.name}
// Effect: ${action.effectType}

export function ${action.name}(${params}): [Context, Effect<${action.effectType}>] {
  // TODO: Implement action
  return [ctx, { type: '${action.effectType}', payload: {} }];
}

// Guard helper (if needed):
// export function ${action.name}_guard(ctx: Context): boolean {
//   return true;
// }
`;
  }

  const tsDTComment = matchedDT ? '\n' + generateDTCallComment(matchedDT, 'typescript') + '\n' : '';
  const tsTodo = matchedDT
    ? `  // TODO: Implement action using ${matchedDT.name} decision table`
    : '  // TODO: Implement action';
  return `// Action: ${action.name}${matchedDT ? `\n// Decision table: ${matchedDT.name}` : ''}

export function ${action.name}(ctx: Context): Context {${tsDTComment}
${tsTodo}
  return { ...ctx };
}
`;
}

export interface RefineSkillResult {
  status: 'success' | 'requires_refinement' | 'error';
  corrected?: string;
  verification?: VerifySkillResult;
  iterations?: number;
  changes: string[];
  error?: string;
}

export async function refineSkill(
  input: SkillInput,
  errors: SkillError[],
  configPath?: string,
  maxIterations: number = 3
): Promise<RefineSkillResult> {
  const config = loadConfig(configPath);
  const provider = createProvider(config.provider, {
    api_key: config.api_key,
    base_url: config.base_url,
    model: config.model,
    max_tokens: config.max_tokens,
    temperature: config.temperature,
  });

  const initialSource = resolveSource(input);
  const initialMachine = parseSource(resolveLabel(input), initialSource);
  const isMd = input.source !== undefined || (input.file !== undefined && (input.file.endsWith('.orca.md') || input.file.endsWith('.md')));

  const systemPrompt = `You are an expert in Orca state machine language. Given verification errors, fix the machine definition.
Output ONLY the corrected Orca machine definition in ${isMd ? 'markdown (.orca.md)' : 'DSL (.orca)'} format, no explanations.`;

  let currentSource = initialSource;
  let currentErrors = errors;
  let machineName = initialMachine.name;
  let machineStates = initialMachine.states.map(s => s.name).join(', ');
  let machineEvents = initialMachine.events.join(', ');

  for (let i = 0; i < maxIterations; i++) {
    const errorList = currentErrors.map(e => `[${e.severity.toUpperCase()}] ${e.code}: ${e.message}`).join('\n');

    const userPrompt = `Machine: ${machineName}
States: ${machineStates}
Events: ${machineEvents}

Verification Errors:
${errorList}

Machine Definition:
${currentSource}

Provide the corrected machine definition:`;

    try {
      const response = await provider.complete({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        model: '',
        max_tokens: 4096,
        temperature: 0.3,
      });

      currentSource = stripCodeFence(response.content);
      const verification = await verifySkill({ source: currentSource });

      if (verification.status === 'valid') {
        return {
          status: 'success',
          corrected: currentSource,
          verification,
          iterations: i + 1,
          changes: [`Corrected after ${i + 1} iteration(s)`],
        };
      }

      currentErrors = verification.errors.filter(e => e.severity === 'error');
      // Update machine metadata for next iteration prompt
      try {
        const m = parseSource('<refined>', currentSource);
        machineName = m.name;
        machineStates = m.states.map(s => s.name).join(', ');
        machineEvents = m.events.join(', ');
      } catch {
        // parse error — keep previous metadata, errors already include PARSE_ERROR
      }
    } catch (err) {
      return {
        status: 'error',
        changes: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const finalVerification = await verifySkill({ source: currentSource });
  return {
    status: 'requires_refinement',
    corrected: currentSource,
    verification: finalVerification,
    iterations: maxIterations,
    changes: [`${maxIterations} iteration(s) attempted but errors remain`],
  };
}

export const ORCA_SYNTAX_REFERENCE = `Orca State Machine Markdown Syntax Reference (.orca.md):

The machine definition uses standard markdown: headings, tables, bullet lists, and blockquotes.

CRITICAL SYNTAX RULES (do not deviate):
- Initial state: MUST use [initial] in the heading: \`## state stateName [initial]\`
  There is NO alternative syntax. Never use "initial: true" or any other form.
- Final state: MUST use [final] in the heading: \`## state stateName [final]\`
  There is NO alternative syntax. Never use "final: true" or any other form.
- Every state referenced in transitions MUST have a \`## state\` heading declared.

## Complete example (self-contained, valid machine):

\`\`\`orca.md
# machine OrderProcessor

## context

| Field    | Type    | Default  |
|----------|---------|----------|
| orderId  | string  |          |
| retries  | int     | 0        |
| error    | string? |          |

## events

- submit
- payment_ok
- payment_failed
- retry
- cancel

## state idle [initial]
> Waiting for an order to be submitted
- ignore: payment_ok, payment_failed, retry

## state processing
> Processing the payment
- on_entry: start_payment
- timeout: 30s -> failed

## state done [final]
> Order complete

## state failed
> Payment failed
- ignore: submit, payment_ok

## transitions

| Source     | Event           | Guard          | Target     | Action          |
|------------|-----------------|----------------|------------|-----------------|
| idle       | submit          |                | processing | init_order      |
| idle       | cancel          |                | idle       |                 |
| processing | payment_ok      |                | done       | complete_order  |
| processing | payment_failed  | can_retry      | failed     | record_error    |
| processing | payment_failed  | !can_retry     | failed     | record_error    |
| processing | cancel          |                | idle       | cancel_order    |
| failed     | retry           | can_retry      | processing | increment_retry |
| failed     | cancel          |                | idle       | cancel_order    |

## guards

| Name      | Expression           |
|-----------|----------------------|
| can_retry | \`ctx.retries < 3\`    |

## actions

| Name             | Signature                                    |
|------------------|----------------------------------------------|
| init_order       | \`(ctx, event) -> Context\`                    |
| start_payment    | \`(ctx) -> Context + Effect<ChargeCard>\`      |
| complete_order   | \`(ctx, event) -> Context\`                    |
| record_error     | \`(ctx, event) -> Context\`                    |
| increment_retry  | \`(ctx) -> Context\`                           |
| cancel_order     | \`(ctx) -> Context\`                           |
\`\`\`

## Full syntax reference:

# machine MachineName

## context

| Field  | Type    | Default |
|--------|---------|---------|
| field1 | string  |         |
| field2 | int     | 0       |
| field3 | string? |         |
| field4 | bool    |         |

## events

- event1
- event2
- event3

## state idle [initial]
> Description of this state
- on_entry: action_name
- on_exit: action_name
- timeout: 5s -> target_state
- ignore: event1, event2

## state active
> An intermediate state (no [initial] or [final] marker)

## state done [final]
> Terminal state

## transitions

| Source | Event  | Guard  | Target | Action  |
|--------|--------|--------|--------|---------|
| idle   | event1 |        | active | action1 |
| active | event2 | guard1 | done   | action2 |
| active | event2 | !guard1| idle   |         |

## guards

| Name   | Expression                |
|--------|---------------------------|
| guard1 | \`ctx.field2 > 10\`         |
| guard2 | \`ctx.status == "active"\`  |

NOTE: Guards support ONLY: comparisons (< > == != <= >=), null checks (== null, != null), boolean operators (and, or, not). NO method calls like .contains(), .includes(), etc.

## actions

| Name    | Signature                                  |
|---------|--------------------------------------------|
| action1 | \`(ctx) -> Context\`                         |
| action2 | \`(ctx, event) -> Context\`                  |
| action3 | \`(ctx) -> Context + Effect<EffectType>\`    |

Key syntax notes:
- [initial] marks the initial state — exactly one required, NO other syntax exists
- [final] marks terminal states — zero or more allowed, NO other syntax exists
- Every state name used in transitions MUST be declared with a ## state heading
- Empty action column means "no action" (transition only changes state)
- Guard column uses guard name from guards table; prefix with ! to negate
- Guard expressions in backticks in the guards table
- Action signatures in backticks in the actions table
- Effect<T> in return type means the action emits an effect
- ctx.field accesses context fields (read-only in guards)
- timeout: 5s -> target means 5 second timeout transition
- Action BODIES are NOT written in Orca - only signatures in the actions table
- Transitions reference actions by name; actions are implemented separately
- States are headings (## for top-level, ### for nested children)
- State descriptions use blockquotes (> text)
- File extension should be .orca.md`;

export async function generateOrcaSkill(
  naturalLanguageSpec: string,
  configPath?: string,
  maxIterations: number = 3
): Promise<GenerateOrcaResult> {
  const config = loadConfig(configPath);

  // Determine which env var to check based on provider and base URL
  const isMiniMax = config.base_url?.includes('minimaxi.chat') || config.base_url?.includes('minimax.io');
  const anthropicKey = isMiniMax
    ? (config.api_key || process.env.MINIMAX_API_KEY || process.env.ANTHROPIC_API_KEY)
    : (config.api_key || process.env.ANTHROPIC_API_KEY);
  const openaiKey = config.api_key || process.env.OPENAI_API_KEY;
  const hasKey =
    config.provider === 'openai' ? openaiKey :
    config.provider === 'ollama' ? true :  // Ollama needs no key (local)
    anthropicKey;

  if (!hasKey) {
    const keyName = config.provider === 'openai' ? 'OPENAI_API_KEY'
      : isMiniMax ? 'MINIMAX_API_KEY (or ANTHROPIC_API_KEY)'
      : 'ANTHROPIC_API_KEY';
    return {
      status: 'error',
      error: `No API key available. Set ${keyName} in your environment or .env`,
    };
  }

  const provider = createProvider(config.provider, {
    api_key: config.api_key,
    base_url: config.base_url,
    model: config.model,
    max_tokens: config.max_tokens,
    temperature: config.temperature,
  });

  const systemPrompt = `You are an expert in Orca state machine design. Generate Orca machine definitions in markdown (.orca.md) format from natural language descriptions.

${ORCA_SYNTAX_REFERENCE}

IMPORTANT - Guard Restrictions:
- Guards support ONLY: comparisons (< > == != <= >=), null checks, boolean operators
- NO method calls: do NOT use .contains(), .includes(), .length(), etc.
- For arrays, check .length > 0 or compare to null
- If you need complex logic, compute it in an action and store a boolean flag in context

IMPORTANT - Action Syntax:
- The actions table declares ONLY SIGNATURES (names and types), not implementations
- Write signatures in backticks: \`(ctx) -> Context\`
- NEVER write action bodies
- Transitions reference actions by name only

Important rules:
- Always include exactly ONE initial state marked with [initial]
- Final states should be marked with [final]
- Every (state, event) pair must have a transition OR the event must be ignored
- Use guards for conditional transitions
- Context should contain all data needed for guards and actions
- For effects (API calls, I/O), use Effect<T> return type in the signature

Output ONLY the Orca machine definition in .orca.md markdown format, wrapped in a code fence, with no additional text.`;

  let currentOrca = '';
  let lastErrors: SkillError[] = [];
  let iteration = 0;

  while (iteration < maxIterations) {
    const userPrompt = iteration === 0
      ? `Generate an Orca state machine for:\n${naturalLanguageSpec}`
      : `The previous Orca machine had verification errors. Fix them:\n\nPrevious Orca:\n${currentOrca}\n\nVerification errors:\n${JSON.stringify(lastErrors, null, 2)}\n\nProvide the corrected Orca machine definition:`;

    try {
      const response = await provider.complete({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        model: '',
        max_tokens: 4096,
        temperature: 0.5,
      });

      currentOrca = stripCodeFence(response.content);
      const verification = await verifySkill({ source: currentOrca });

      if (verification.status === 'valid') {
        return {
          status: 'success',
          machine: verification.machine,
          orca: currentOrca,
          verification,
        };
      }

      lastErrors = verification.errors;
      iteration++;
    } catch (err) {
      return {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return {
    status: 'requires_refinement',
    machine: extractMachineNameFromSource(currentOrca),
    orca: currentOrca,
    verification: await verifySkill({ source: currentOrca }).catch(() => ({
      status: 'invalid' as const,
      machine: 'unknown',
      states: 0,
      events: 0,
      transitions: 0,
      errors: [],
    })),
  };
}

// ── /generate-orca-multi ─────────────────────────────────────────────────────

export const MULTI_MACHINE_SYNTAX_ADDENDUM = `
Multi-machine files
-------------------
Separate machines with a line containing only three dashes (---).

A state can invoke another machine in the same file:

  ## state coordinatingState [initial]
  - invoke: ChildMachineName
  - on_done: nextState
  - on_error: errorState

Rules:
- invoke: must name a machine defined in the same file
- on_done: fires when the invoked machine reaches a [final] state
- on_error: fires if the invoked machine cannot proceed
- Each state may invoke at most one child machine
- Circular invocations are not allowed (A invokes B invokes A)
- The coordinator machine should have a clear entry point and delegate work to child machines
- Child machines should have at least one [final] state so the coordinator's on_done can fire
`;

function verifyMultiSource(source: string): { valid: boolean; errors: SkillError[]; machines: string[] } {
  const { file } = parseMarkdown(source);
  const allErrors: SkillError[] = [];

  // Cross-machine checks (cycle detection, unknown machines, input mappings)
  const fileAnalysis = analyzeFile(file);
  for (const e of [...fileAnalysis.errors, ...fileAnalysis.warnings]) {
    allErrors.push({ code: e.code, message: e.message, severity: e.severity, suggestion: e.suggestion });
  }

  // Per-machine checks
  for (const machine of file.machines) {
    const structural = checkStructural(machine);
    const completeness = checkCompleteness(machine);
    const determinism = checkDeterminism(machine);
    const properties = checkProperties(machine);
    for (const e of [
      ...structural.errors,
      ...completeness.errors,
      ...determinism.errors,
      ...properties.errors,
    ]) {
      allErrors.push({
        code: e.code,
        message: `[${machine.name}] ${e.message}`,
        severity: e.severity,
        location: e.location ? { state: e.location.state, event: e.location.event } : undefined,
        suggestion: e.suggestion,
      });
    }
  }

  return {
    valid: !allErrors.some(e => e.severity === 'error'),
    errors: allErrors,
    machines: file.machines.map(m => m.name),
  };
}

export async function generateOrcaMultiSkill(
  naturalLanguageSpec: string,
  configPath?: string,
  maxIterations: number = 3,
): Promise<GenerateMultiResult> {
  const config = loadConfig(configPath);

  // Determine which env var to check based on provider and base URL
  const isMiniMax = config.base_url?.includes('minimaxi.chat') || config.base_url?.includes('minimax.io');
  const anthropicKey = isMiniMax
    ? (config.api_key || process.env.MINIMAX_API_KEY || process.env.ANTHROPIC_API_KEY)
    : (config.api_key || process.env.ANTHROPIC_API_KEY);
  const openaiKey = config.api_key || process.env.OPENAI_API_KEY;
  const hasKey =
    config.provider === 'openai' ? openaiKey :
    config.provider === 'ollama' ? true :
    anthropicKey;

  if (!hasKey) {
    const keyName = config.provider === 'openai' ? 'OPENAI_API_KEY'
      : isMiniMax ? 'MINIMAX_API_KEY (or ANTHROPIC_API_KEY)'
      : 'ANTHROPIC_API_KEY';
    return {
      status: 'error',
      error: `No API key available. Set ${keyName} in your environment or .env`,
    };
  }

  const provider = createProvider(config.provider, {
    api_key: config.api_key,
    base_url: config.base_url,
    model: config.model,
    max_tokens: config.max_tokens,
    temperature: config.temperature,
  });

  const systemPrompt = `You are an expert in Orca state machine design. Generate coordinated multi-machine Orca definitions in markdown (.orca.md) format from natural language descriptions.

${ORCA_SYNTAX_REFERENCE}
${MULTI_MACHINE_SYNTAX_ADDENDUM}

IMPORTANT - Guard Restrictions:
- Guards support ONLY: comparisons (< > == != <= >=), null checks, boolean operators
- NO method calls: do NOT use .contains(), .includes(), .length(), etc.
- If you need complex logic, compute it in an action and store a boolean flag in context

IMPORTANT - Action Syntax:
- The actions table declares ONLY SIGNATURES (names and types), not implementations
- Write signatures in backticks: \`(ctx) -> Context\`
- NEVER write action bodies

Multi-machine design principles:
- Design a clear coordinator machine that delegates to focused child machines
- Each child machine should have a single responsibility and at least one [final] state
- Use invoke: in coordinator states to call child machines
- Separate machines with --- on its own line
- Name machines clearly (e.g. OrderCoordinator, PaymentProcessor, NotificationSender)

Output ONLY the complete multi-machine Orca definition in .orca.md markdown format, wrapped in a code fence, with no additional text.`;

  let currentOrca = '';
  let lastErrors: SkillError[] = [];
  let iteration = 0;

  while (iteration < maxIterations) {
    const userPrompt = iteration === 0
      ? `Generate a multi-machine Orca state machine system for:\n${naturalLanguageSpec}\n\nDesign at least 2 coordinated machines separated by ---`
      : `The previous multi-machine Orca definition had verification errors. Fix them:\n\nPrevious Orca:\n${currentOrca}\n\nVerification errors:\n${JSON.stringify(lastErrors, null, 2)}\n\nProvide the corrected multi-machine Orca definition:`;

    try {
      const response = await provider.complete({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        model: '',
        max_tokens: 8192,
        temperature: 0.5,
      });

      currentOrca = stripCodeFence(response.content);

      let verification: { valid: boolean; errors: SkillError[]; machines: string[] };
      try {
        verification = verifyMultiSource(currentOrca);
      } catch (parseErr) {
        lastErrors = [{
          code: 'PARSE_ERROR',
          message: parseErr instanceof Error ? parseErr.message : String(parseErr),
          severity: 'error',
        }];
        iteration++;
        continue;
      }

      if (verification.valid) {
        return {
          status: 'success',
          machines: verification.machines,
          orca: currentOrca,
        };
      }

      lastErrors = verification.errors.filter(e => e.severity === 'error');
      iteration++;
    } catch (err) {
      return {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  let finalMachines: string[] = [];
  try {
    const { file } = parseMarkdown(currentOrca);
    finalMachines = file.machines.map(m => m.name);
  } catch { /* ignore */ }

  return {
    status: 'requires_refinement',
    machines: finalMachines,
    orca: currentOrca,
    errors: lastErrors,
  };
}

// ── Shared provider resolution ────────────────────────────────────────────────

function tryCreateProvider(configPath?: string): { provider: LLMProvider; config: ReturnType<typeof loadConfig> } | { error: string } {
  const config = loadConfig(configPath);
  const isMiniMax = config.base_url?.includes('minimaxi.chat') || config.base_url?.includes('minimax.io');
  const anthropicKey = isMiniMax
    ? (config.api_key || process.env.MINIMAX_API_KEY || process.env.ANTHROPIC_API_KEY)
    : (config.api_key || process.env.ANTHROPIC_API_KEY);
  const openaiKey = config.api_key || process.env.OPENAI_API_KEY;
  const hasKey =
    config.provider === 'openai' ? openaiKey :
    config.provider === 'ollama' ? true :
    anthropicKey;

  if (!hasKey) {
    const keyName = config.provider === 'openai' ? 'OPENAI_API_KEY'
      : isMiniMax ? 'MINIMAX_API_KEY (or ANTHROPIC_API_KEY)'
      : 'ANTHROPIC_API_KEY';
    return { error: `No API key available. Set ${keyName} in your environment or .env` };
  }

  return {
    config,
    provider: createProvider(config.provider, {
      api_key: config.api_key,
      base_url: config.base_url,
      model: config.model,
      max_tokens: config.max_tokens,
      temperature: config.temperature,
    }),
  };
}

// ── /generate-machine (single draft step, no verify loop) ────────────────────

export interface GenerateOrcaDraftResult {
  status: 'success' | 'error';
  machine?: string;   // parsed from draft for caller convenience
  orca?: string;
  error?: string;
}

export async function generateOrcaDraftSkill(
  naturalLanguageSpec: string,
  configPath?: string,
): Promise<GenerateOrcaDraftResult> {
  const providerResult = tryCreateProvider(configPath);
  if ('error' in providerResult) {
    return { status: 'error', error: providerResult.error };
  }
  const { provider } = providerResult;

  const systemPrompt = `You are an expert in Orca state machine design. Generate Orca machine definitions in markdown (.orca.md) format from natural language descriptions.

${ORCA_SYNTAX_REFERENCE}

IMPORTANT - Guard Restrictions:
- Guards support ONLY: comparisons (< > == != <= >=), null checks, boolean operators
- NO method calls: do NOT use .contains(), .includes(), .length(), etc.
- For arrays, check .length > 0 or compare to null
- If you need complex logic, compute it in an action and store a boolean flag in context

IMPORTANT - Action Syntax:
- The actions table declares ONLY SIGNATURES (names and types), not implementations
- Write signatures in backticks: \`(ctx) -> Context\`
- NEVER write action bodies
- Transitions reference actions by name only

Important rules:
- Always include exactly ONE initial state marked with [initial]
- Final states should be marked with [final]
- Every (state, event) pair must have a transition OR the event must be ignored
- Use guards for conditional transitions
- Context should contain all data needed for guards and actions
- For effects (API calls, I/O), use Effect<T> return type in the signature

Output ONLY the Orca machine definition in .orca.md markdown format, wrapped in a code fence, with no additional text.`;

  try {
    const response = await provider.complete({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Generate an Orca state machine for:\n${naturalLanguageSpec}` },
      ],
      model: '',
      max_tokens: 4096,
      temperature: 0.5,
    });

    const orca = stripCodeFence(response.content);
    const machine = extractMachineNameFromSource(orca);
    return { status: 'success', machine, orca };
  } catch (err) {
    return { status: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

// ── /generate-multi-machine (single draft step, no verify loop) ───────────────

export interface GenerateOrcaMultiDraftResult {
  status: 'success' | 'error';
  machines?: string[];   // machine names parsed from draft
  orca?: string;
  error?: string;
}

export async function generateOrcaMultiDraftSkill(
  naturalLanguageSpec: string,
  configPath?: string,
): Promise<GenerateOrcaMultiDraftResult> {
  const providerResult = tryCreateProvider(configPath);
  if ('error' in providerResult) {
    return { status: 'error', error: providerResult.error };
  }
  const { provider } = providerResult;

  const systemPrompt = `You are an expert in Orca state machine design. Generate coordinated multi-machine Orca definitions in markdown (.orca.md) format from natural language descriptions.

${ORCA_SYNTAX_REFERENCE}
${MULTI_MACHINE_SYNTAX_ADDENDUM}

IMPORTANT - Guard Restrictions:
- Guards support ONLY: comparisons (< > == != <= >=), null checks, boolean operators
- NO method calls: do NOT use .contains(), .includes(), .length(), etc.
- If you need complex logic, compute it in an action and store a boolean flag in context

IMPORTANT - Action Syntax:
- The actions table declares ONLY SIGNATURES (names and types), not implementations
- Write signatures in backticks: \`(ctx) -> Context\`
- NEVER write action bodies

Multi-machine design principles:
- Design a clear coordinator machine that delegates to focused child machines
- Each child machine should have a single responsibility and at least one [final] state
- Use invoke: in coordinator states to call child machines
- Separate machines with --- on its own line
- Name machines clearly (e.g. OrderCoordinator, PaymentProcessor, NotificationSender)

Output ONLY the complete multi-machine Orca definition in .orca.md markdown format, wrapped in a code fence, with no additional text.`;

  try {
    const response = await provider.complete({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Generate a multi-machine Orca state machine system for:\n${naturalLanguageSpec}\n\nDesign at least 2 coordinated machines separated by ---` },
      ],
      model: '',
      max_tokens: 8192,
      temperature: 0.5,
    });

    const orca = stripCodeFence(response.content);
    let machines: string[] = [];
    try {
      const { file } = parseMarkdown(orca);
      machines = file.machines.map(m => m.name);
    } catch { /* ignore parse errors — caller will see them via verify_machine */ }
    return { status: 'success', machines, orca };
  } catch (err) {
    return { status: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Auto-routing: single vs multi-machine heuristic ──────────────────────────

/**
 * Returns true when the spec clearly describes coordination between multiple
 * independent sub-machines rather than a single workflow with many states.
 *
 * Conservative by design — single-machine handles most workflows well.
 * Only routes to multi when the spec explicitly uses coordination vocabulary
 * or describes a named coordinator managing distinct child processes.
 */
export function detectMultiMachine(spec: string): boolean {
  const lower = spec.toLowerCase();

  // 1. Explicit coordinator / orchestrator vocabulary
  if (/\b(coordinator|orchestrator|orchestrate)\b/.test(lower)) return true;

  // 2. Explicit multi-machine phrasing
  if (/multi.?machine|multiple machines|child machine|sub.?machine/.test(lower)) return true;

  // 3. Coordination pattern: "X coordinates/manages/oversees Y and Z"
  //    where the sub-things sound like independent workflows
  if (/\b(coordinate[sd]?|orchestrate[sd]?|manages?|oversees?)\b.{0,120}\band\b.{0,80}\b(machine|workflow|pipeline|process|worker|agent)\b/i.test(spec)) return true;

  return false;
}

export interface GenerateAutoResult {
  status: 'success' | 'error';
  is_multi: boolean;
  machine?: string;      // single-machine: name of the machine
  machines?: string[];   // multi-machine: names of all machines
  orca?: string;
  error?: string;
}

/**
 * Auto-routing entry point for generate_machine.
 * Inspects the spec and delegates to the single- or multi-machine draft
 * generator. Always returns a draft — caller should follow up with
 * verify_machine → refine_machine (if errors) → verify_machine.
 */
export async function generateAutoSkill(
  naturalLanguageSpec: string,
  configPath?: string,
): Promise<GenerateAutoResult> {
  const isMulti = detectMultiMachine(naturalLanguageSpec);

  if (isMulti) {
    const result = await generateOrcaMultiDraftSkill(naturalLanguageSpec, configPath);
    return {
      status: result.status,
      is_multi: true,
      machines: result.machines,
      orca: result.orca,
      error: result.error,
    };
  } else {
    const result = await generateOrcaDraftSkill(naturalLanguageSpec, configPath);
    return {
      status: result.status,
      is_multi: false,
      machine: result.machine,
      orca: result.orca,
      error: result.error,
    };
  }
}

function stripCodeFence(code: string): string {
  return code
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^```(?:orca|markdown|md|orca\.md)?\n/, '')
    .replace(/^```\n/, '')
    .replace(/\n```$/, '')
    .trim();
}

function extractMachineNameFromSource(orca: string): string {
  // Support both DSL format (machine Name) and markdown format (# machine Name)
  const match = orca.match(/^(?:#\s+)?machine\s+(\w+)/m);
  return match ? match[1] : 'Unknown';
}

// ============================================================
// Decision Table Skills
// ============================================================

export interface VerifyDTSkillResult {
  status: 'valid' | 'invalid';
  decisionTable: string;
  conditions: number;
  actions: number;
  rules: number;
  errors: SkillError[];
}

export interface CompileDTSkillResult {
  status: 'success' | 'error';
  target: 'typescript' | 'json';
  output: string;
  warnings: SkillError[];
}

/**
 * Parse a decision table from source.
 */
export function parseDTSkill(input: SkillInput): { status: 'success' | 'error'; decisionTables?: object[]; error?: string } {
  try {
    const source = resolveSource(input);
    const { file } = parseMarkdown(source);

    if (file.decisionTables.length === 0) {
      return { status: 'error', error: 'No decision table found in source' };
    }

    // Return all decision tables as plain objects
    const tables = file.decisionTables.map(dt => ({
      name: dt.name,
      description: dt.description,
      conditions: dt.conditions.map(c => ({
        name: c.name,
        type: c.type,
        values: c.values,
        range: c.range,
      })),
      actions: dt.actions.map(a => ({
        name: a.name,
        type: a.type,
        description: a.description,
        values: a.values,
      })),
      rules: dt.rules.map(r => ({
        number: r.number,
        conditions: Object.fromEntries(r.conditions),
        actions: Object.fromEntries(r.actions),
      })),
      policy: dt.policy,
    }));

    return { status: 'success', decisionTables: tables };
  } catch (err) {
    return { status: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Verify a decision table.
 */
export function verifyDTSkill(input: SkillInput): VerifyDTSkillResult {
  try {
    const source = resolveSource(input);
    const { file } = parseMarkdown(source);

    if (file.decisionTables.length === 0) {
      return {
        status: 'invalid',
        decisionTable: '',
        conditions: 0,
        actions: 0,
        rules: 0,
        errors: [{ code: 'DT_NOT_FOUND', message: 'No decision table found in source', severity: 'error' }],
      };
    }

    // Verify all decision tables
    const verification = verifyDecisionTables(file.decisionTables);

    // Return result for the first decision table
    const dt = file.decisionTables[0];
    const errors: SkillError[] = [];
    for (const e of verification.errors) {
      const loc = e.location;
      errors.push({
        code: e.code,
        message: e.message,
        severity: e.severity as 'error' | 'warning',
        location: loc ? {
          state: loc.state,
          event: loc.event,
          rule: loc.rule,
          condition: loc.condition,
          action: loc.action,
          decisionTable: loc.decisionTable,
        } : undefined,
        suggestion: e.suggestion,
      });
    }

    return {
      status: verification.valid ? 'valid' : 'invalid',
      decisionTable: dt.name,
      conditions: dt.conditions.length,
      actions: dt.actions.length,
      rules: dt.rules.length,
      errors,
    };
  } catch (err) {
    return {
      status: 'invalid',
      decisionTable: '',
      conditions: 0,
      actions: 0,
      rules: 0,
      errors: [{ code: 'PARSE_ERROR', message: err instanceof Error ? err.message : String(err), severity: 'error' }],
    };
  }
}

/**
 * Compile a decision table to TypeScript or JSON.
 */
export function compileDTSkill(input: SkillInput, target: 'typescript' | 'json' = 'typescript'): CompileDTSkillResult {
  try {
    const source = resolveSource(input);
    const { file } = parseMarkdown(source);

    if (file.decisionTables.length === 0) {
      return {
        status: 'error',
        target,
        output: '',
        warnings: [{ code: 'DT_NOT_FOUND', message: 'No decision table found in source', severity: 'error' }],
      };
    }

    const dt = file.decisionTables[0];
    const output = target === 'json'
      ? compileDecisionTableToJSON(dt)
      : compileDecisionTableToTypeScript(dt);

    return { status: 'success', target, output, warnings: [] };
  } catch (err) {
    return {
      status: 'error',
      target,
      output: '',
      warnings: [{ code: 'COMPILE_ERROR', message: err instanceof Error ? err.message : String(err), severity: 'error' }],
    };
  }
}

// Decision table syntax reference for LLM generation
const DT_SYNTAX_REFERENCE = `
# decision_table Name

## conditions

| Name | Type | Values |
|------|------|--------|
| field_name | enum | value1, value2 |
| is_active | bool | |
| count | int_range | 1..100 |

## actions

| Name | Type | Description |
|------|------|-------------|
| result | enum | Result description |
| flag | bool | Whether something |

## rules

| condition1 | condition2 | → action1 | → action2 |
|------------|-----------|----------|-----------|
| value1 | - | result1 | true |
| value2 | !value3 | result2 | false |

Notes:
- "-" in a condition cell means "any" (wildcard)
- "!value" negates a value
- "a,b" matches any of the values (OR semantics)
- Rules are evaluated top-to-bottom; first match wins
`;

/**
 * Generate a decision table from natural language spec.
 */
export async function generateDTSkill(spec: string, configPath?: string): Promise<{
  status: 'success' | 'error' | 'requires_refinement';
  decisionTable?: string;
  orca?: string;
  verification?: VerifyDTSkillResult;
  error?: string;
}> {
  const config = loadConfig(configPath);
  const provider = createProvider(config.provider, {
    api_key: config.api_key,
    base_url: config.base_url,
    model: config.model,
    max_tokens: config.max_tokens,
    temperature: config.temperature,
  });

  if (!provider) {
    return { status: 'error', error: 'No LLM provider configured' };
  }

  const prompt = `Generate a decision table in .orca.md format based on the following specification.

${DT_SYNTAX_REFERENCE}

Specification:
${spec}

Respond with the decision table only, no explanation.`;

  try {
    const response = await provider.complete({
      messages: [{ role: 'user', content: prompt }],
      model: '',
      max_tokens: config.max_tokens || 2048,
      temperature: 0.7,
    });

    const orca = stripCodeFence(response.content);

    // Verify the generated decision table
    const { file } = parseMarkdown(orca);
    if (file.decisionTables.length === 0) {
      return { status: 'error', error: 'Generated content does not contain a valid decision table', orca };
    }

    const verification = verifyDecisionTables(file.decisionTables);

    return {
      status: verification.valid ? 'success' : 'requires_refinement',
      decisionTable: file.decisionTables[0].name,
      orca,
      verification: verification.valid ? undefined : {
        status: 'invalid',
        decisionTable: file.decisionTables[0].name,
        conditions: file.decisionTables[0].conditions.length,
        actions: file.decisionTables[0].actions.length,
        rules: file.decisionTables[0].rules.length,
        errors: verification.errors.map(e => ({
          code: e.code,
          message: e.message,
          severity: e.severity,
          location: e.location,
          suggestion: e.suggestion,
        })),
      },
    };
  } catch (err) {
    return { status: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

