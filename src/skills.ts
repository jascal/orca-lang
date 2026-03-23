import { readFileSync } from 'fs';
import { tokenize } from './parser/lexer.js';
import { parse } from './parser/parser.js';
import { checkStructural } from './verifier/structural.js';
import { checkCompleteness } from './verifier/completeness.js';
import { checkDeterminism } from './verifier/determinism.js';
import { compileToXState } from './compiler/xstate.js';
import { compileToMermaid } from './compiler/mermaid.js';
import { MachineDef } from './parser/ast.js';
import { loadConfig, resolveConfigOverrides } from './config/index.js';
import { createProvider } from './llm/index.js';
import type { LLMProvider } from './llm/index.js';
import { getCodeGenerator } from './generators/index.js';
import { CodeGeneratorType } from './config/types.js';

export interface SkillError {
  code: string;
  message: string;
  severity: 'error' | 'warning';
  location?: {
    state?: string;
    event?: string;
    transition?: string;
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
}

export async function verifySkill(filePath: string): Promise<VerifySkillResult> {
  const source = readFileSync(filePath, 'utf-8');
  const tokens = tokenize(source);
  const result = parse(tokens);
  const machine = result.machine;

  const structural = checkStructural(machine);
  const completeness = checkCompleteness(machine);
  const determinism = checkDeterminism(machine);

  const allErrors: SkillError[] = [
    ...structural.errors.map(e => ({
      code: e.code,
      message: e.message,
      severity: e.severity,
      location: e.location ? {
        state: e.location.state,
        event: e.location.event,
      } : undefined,
      suggestion: e.suggestion,
    })),
    ...completeness.errors.map(e => ({
      code: e.code,
      message: e.message,
      severity: e.severity,
      location: e.location ? {
        state: e.location.state,
        event: e.location.event,
      } : undefined,
      suggestion: e.suggestion,
    })),
    ...determinism.errors.map(e => ({
      code: e.code,
      message: e.message,
      severity: e.severity,
      location: e.location ? {
        state: e.location.state,
        event: e.location.event,
      } : undefined,
      suggestion: e.suggestion,
    })),
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

export async function compileSkill(filePath: string, target: 'xstate' | 'mermaid'): Promise<CompileSkillResult> {
  const source = readFileSync(filePath, 'utf-8');
  const tokens = tokenize(source);
  const result = parse(tokens);

  // Run verification to get warnings
  const structural = checkStructural(result.machine);
  const completeness = checkCompleteness(result.machine);
  const determinism = checkDeterminism(result.machine);

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
    ? compileToXState(result.machine)
    : compileToMermaid(result.machine);

  return {
    status: 'success',
    target,
    output,
    warnings,
  };
}

export async function generateActionsSkill(
  filePath: string,
  language: string = 'typescript',
  useLLM: boolean = false,
  configPath?: string
): Promise<GenerateActionsResult> {
  const source = readFileSync(filePath, 'utf-8');
  const tokens = tokenize(source);
  const result = parse(tokens);
  const machine = result.machine;

  const actions: ActionScaffold[] = machine.actions.map(action => ({
    name: action.name,
    signature: `${action.name}(${action.parameters.join(', ')}) -> ${action.returnType}${action.hasEffect ? ` + Effect<${action.effectType}>` : ''}`,
    parameters: action.parameters,
    returnType: action.returnType,
    hasEffect: action.hasEffect,
    effectType: action.effectType,
    context_used: extractContextFields(machine, action.name),
  }));

  let scaffolds: Record<string, string> = {};

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

    scaffolds = await generateWithLLM(provider, actions, machine, language as CodeGeneratorType);
  } else {
    // Use template-based scaffold generation
    for (const action of machine.actions) {
      scaffolds[action.name] = generateActionScaffold(action, machine, language);
    }
  }

  return {
    status: 'success',
    machine: machine.name,
    actions,
    scaffolds,
  };
}

async function generateWithLLM(
  provider: LLMProvider,
  actions: ActionScaffold[],
  machine: MachineDef,
  language: CodeGeneratorType
): Promise<Record<string, string>> {
  const generator = getCodeGenerator(language);
  const scaffolds: Record<string, string> = {};

  const systemPrompt = `You are an expert ${language} developer specializing in state machine action implementations.
Given a machine definition and action signatures, generate complete action implementations.
Follow the type signatures exactly. Use the provided context fields.
If an action has an effect, return [newContext, effect] tuple.`;

  for (const action of actions) {
    const userPrompt = `Machine: ${machine.name}
Context fields: ${machine.context.map(f => `${f.name}: ${f.type || 'unknown'}`).join(', ')}

Action: ${action.signature}
Description: ${action.name}${action.hasEffect ? ` (effect type: ${action.effectType})` : ''}

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
      // Fall back to scaffold on error
      scaffolds[action.name] = generateActionScaffold(action, machine, language);
    }
  }

  return scaffolds;
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

function generateActionScaffold(
  action: { name: string; parameters: string[]; returnType: string; hasEffect: boolean; effectType?: string },
  machine: MachineDef,
  language: string
): string {
  const ctxType = 'Context';
  const params = action.parameters.map(p => {
    if (p === 'ctx' || p === 'Context') return 'ctx: Context';
    if (p.startsWith('event:')) return p;
    return `ctx: Context, ${p}`;
  }).join(', ');

  if (language === 'typescript') {
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
    return `// Action: ${action.name}

export function ${action.name}(ctx: Context): Context {
  // TODO: Implement action
  return { ...ctx };
}
`;
  }

  // Default to TypeScript
  return generateActionScaffold(action, machine, 'typescript');
}

export async function refineSkill(
  filePath: string,
  errors: SkillError[],
  configPath?: string
): Promise<{ status: string; corrected?: string; changes: string[]; error?: string }> {
  const config = loadConfig(configPath);
  const provider = createProvider(config.provider, {
    api_key: config.api_key,
    base_url: config.base_url,
    model: config.model,
    max_tokens: config.max_tokens,
    temperature: config.temperature,
  });

  const source = readFileSync(filePath, 'utf-8');
  const tokens = tokenize(source);
  const result = parse(tokens);
  const machine = result.machine;

  const systemPrompt = `You are an expert in Orca state machine language. Given verification errors, fix the machine definition.
Output ONLY the corrected Orca machine definition, no explanations.`;

  const errorList = errors.map(e => `[${e.severity.toUpperCase()}] ${e.code}: ${e.message}`).join('\n');

  const userPrompt = `Machine: ${machine.name}
States: ${machine.states.map(s => s.name).join(', ')}
Events: ${machine.events.join(', ')}

Verification Errors:
${errorList}

Original Machine Definition:
${source}

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

    return {
      status: 'success',
      corrected: response.content,
      changes: ['LLM-generated corrections applied'],
    };
  } catch (err) {
    return {
      status: 'error',
      changes: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
