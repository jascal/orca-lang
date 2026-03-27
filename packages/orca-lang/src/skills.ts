import { readFileSync } from 'fs';
import { parseMarkdown } from './parser/markdown-parser.js';
import { checkStructural } from './verifier/structural.js';
import { checkCompleteness } from './verifier/completeness.js';
import { checkDeterminism } from './verifier/determinism.js';
import { checkProperties } from './verifier/properties.js';
import { compileToXState } from './compiler/xstate.js';
import { compileToMermaid } from './compiler/mermaid.js';
import { MachineDef } from './parser/ast.js';
import { loadConfig, resolveConfigOverrides } from './config/index.js';
import { createProvider } from './llm/index.js';
import type { LLMProvider } from './llm/index.js';
import { getCodeGenerator } from './generators/index.js';
import { CodeGeneratorType } from './config/types.js';

/** Parse an Orca machine definition file (markdown format) */
function parseFile(filePath: string, source: string): MachineDef {
  const { file } = parseMarkdown(source);
  if (file.machines.length > 1) {
    throw new Error(`File ${filePath} contains multiple machines.`);
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
  tests?: Record<string, string>;
}

export interface GenerateOrcaResult {
  status: 'success' | 'error' | 'requires_refinement';
  machine?: string;
  orca?: string;
  verification?: VerifySkillResult;
  error?: string;
}

export async function verifySkill(filePath: string): Promise<VerifySkillResult> {
  const source = readFileSync(filePath, 'utf-8');

  let machine: MachineDef;
  try {
    machine = parseFile(filePath, source);
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
  const properties = checkProperties(machine);

  const mapError = (e: { code: string; message: string; severity: 'error' | 'warning'; location?: { state?: string; event?: string }; suggestion?: string }): SkillError => ({
    code: e.code,
    message: e.message,
    severity: e.severity,
    location: e.location ? {
      state: e.location.state,
      event: e.location.event,
    } : undefined,
    suggestion: e.suggestion,
  });

  const allErrors: SkillError[] = [
    ...structural.errors.map(mapError),
    ...completeness.errors.map(mapError),
    ...determinism.errors.map(mapError),
    ...properties.errors.map(mapError),
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
  const machine = parseFile(filePath, source);

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
  filePath: string,
  language: string = 'typescript',
  useLLM: boolean = false,
  configPath?: string,
  generateTests: boolean = false
): Promise<GenerateActionsResult> {
  const source = readFileSync(filePath, 'utf-8');
  const machine = parseFile(filePath, source);

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

    scaffolds = await generateWithLLM(provider, actions, machine, language as CodeGeneratorType);

    if (generateTests) {
      tests = await generateUnitTests(provider, actions, machine, language as CodeGeneratorType);
    }
  } else {
    // Use template-based scaffold generation
    for (const action of machine.actions) {
      scaffolds[action.name] = generateActionScaffold(action, machine, language);
    }

    if (generateTests) {
      tests = generateTemplateTests(actions, machine);
    }
  }

  return {
    status: 'success',
    machine: machine.name,
    actions,
    scaffolds,
    tests: Object.keys(tests).length > 0 ? tests : undefined,
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
      console.error(`LLM error for action ${action.name}: ${err instanceof Error ? err.message : String(err)}`);
      // Fall back to scaffold on error
      scaffolds[action.name] = generateActionScaffold(action, machine, language);
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

function generateTemplateTests(actions: ActionScaffold[], machine: MachineDef): Record<string, string> {
  const tests: Record<string, string> = {};

  for (const action of actions) {
    tests[action.name] = generateTemplateTestsForAction(action, machine);
  }

  return tests;
}

function generateTemplateTestsForAction(action: ActionScaffold, machine: MachineDef): string {
  const ctxFields = machine.context.map(f => {
    const defaultValue = getDefaultValueForType(f.type);
    return `    ${f.name}: ${defaultValue}`;
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

function getDefaultValueForType(type: any): string {
  if (!type) return "''";
  if (typeof type === 'object' && 'kind' in type) {
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
  return 'null';
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
  const machine = parseFile(filePath, source);

  const isMd = filePath.endsWith('.orca.md') || filePath.endsWith('.md');

  const systemPrompt = `You are an expert in Orca state machine language. Given verification errors, fix the machine definition.
Output ONLY the corrected Orca machine definition in ${isMd ? 'markdown (.orca.md)' : 'DSL (.orca)'} format, no explanations.`;

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

const ORCA_SYNTAX_REFERENCE = `Orca State Machine Markdown Syntax Reference (.orca.md):

The machine definition uses standard markdown: headings, tables, bullet lists, and blockquotes.

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
- [initial] marks the initial state (exactly one required)
- [final] marks terminal states (zero or more allowed)
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

  // Check if LLM is available
  if (!config.api_key && !process.env.ANTHROPIC_API_KEY && !process.env.MINIMAX_API_KEY) {
    return {
      status: 'error',
      error: 'No API key available. Set ANTHROPIC_API_KEY or MINIMAX_API_KEY in .env',
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

      // Extract Orca code from response
      currentOrca = stripCodeFence(response.content);

      // Verify the generated Orca (markdown format)
      const tempFile = `/tmp/orca_gen_${Date.now()}.orca.md`;
      const { writeFileSync } = await import('fs');
      writeFileSync(tempFile, currentOrca);

      const verification = await verifySkill(tempFile);

      if (verification.status === 'valid') {
        // Clean up temp file
        try {
          const { unlinkSync } = await import('fs');
          unlinkSync(tempFile);
        } catch {}

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
    verification: await verifySkill(`/tmp/orca_gen_${Date.now()}.orca.md`).catch(() => ({
      status: 'invalid' as const,
      machine: 'unknown',
      states: 0,
      events: 0,
      transitions: 0,
      errors: [],
    })),
  };
}

let lastErrors: SkillError[] = [];

function stripCodeFence(code: string): string {
  return code
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
