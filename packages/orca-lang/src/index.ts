#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { setAuthProfile, deleteAuthProfile, listAuthProfiles, getAuthProfile } from './auth/store.js';
import { getValidAccessToken } from './auth/refresh.js';
import {
  buildAuthorizationUrl as buildAnthropicUrl,
  getDeviceCode,
  pollForToken,
  promptForCode,
  openBrowser,
  anthropicOAuthProvider,
} from './auth/providers/anthropic.js';
import {
  buildAuthorizationUrl as buildMiniMaxUrl,
  minimaxOAuthProvider,
} from './auth/providers/minimax.js';
import { parseMarkdown } from './parser/markdown-parser.js';
import { machineToMarkdown } from './parser/ast-to-markdown.js';
import { checkStructural, analyzeFile } from './verifier/structural.js';
import { checkCompleteness } from './verifier/completeness.js';
import { checkDeterminism } from './verifier/determinism.js';
import { checkProperties } from './verifier/properties.js';
import { compileToXState, compileToXStateMachine } from './compiler/xstate.js';
import { compileToMermaid } from './compiler/mermaid.js';
import { verifySkill, compileSkill, generateActionsSkill, refineSkill, generateOrcaSkill, generateOrcaMultiSkill, parseSkill, type SkillInput } from './skills.js';
import { ORCA_TOOLS } from './tools.js';
import { createOrcaMachine } from './runtime/machine.js';
import type { OrcaMachine, OrcaMachineOptions, OrcaState } from './runtime/types.js';

// Re-export for use as a library
export { parseMarkdown } from './parser/markdown-parser.js';
export { machineToMarkdown } from './parser/ast-to-markdown.js';
export { compileToXState, compileToXStateMachine } from './compiler/xstate.js';
export { compileToMermaid } from './compiler/mermaid.js';
export { checkProperties } from './verifier/properties.js';
export { createOrcaMachine };
export type { OrcaMachine, OrcaMachineOptions, OrcaState, EffectHandlers, EffectResult, Effect } from './runtime/types.js';

import type { MachineDef } from './parser/ast.js';

// ── Stdin helpers ─────────────────────────────────────────────────────────────

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/** Resolve a SkillInput from either a file path or stdin. Pass `-` as fileArg to force stdin. */
async function getInput(fileArg: string | undefined, useStdin: boolean): Promise<SkillInput> {
  if (useStdin || fileArg === '-') return { source: await readStdin() };
  if (fileArg) return { file: fileArg };
  throw new Error('No input file specified. Provide a file path or use --stdin.');
}

/** Read raw source from a SkillInput (used by functions that need the source string directly). */
function sourceFromInput(input: SkillInput): string {
  if (input.source !== undefined) return input.source;
  if (input.file !== undefined) return readFileSync(input.file, 'utf-8');
  throw new Error('SkillInput requires either source or file');
}

/** Parse an Orca machine definition file (markdown format) */
function parseFile(filePath: string, source: string): MachineDef {
  const { file } = parseMarkdown(source);
  if (file.machines.length > 1) {
    throw new Error(`File ${filePath} contains multiple machines. Use a command that supports multi-machine files.`);
  }
  return file.machines[0];
}

async function login(provider: string, profileId: string = 'default'): Promise<void> {
  console.log(`Logging in to ${provider}...`);

  try {
    if (provider === 'anthropic') {
      // Use device code flow for simpler CLI experience
      const deviceCodes = await getDeviceCode();
      console.log(`Please visit: ${deviceCodes.verification_uri}`);
      console.log(`And enter code: ${deviceCodes.user_code}`);
      await openBrowser(deviceCodes.verification_uri);

      const tokens = await pollForToken(deviceCodes.device_code);

      setAuthProfile(profileId, {
        mode: 'oauth',
        provider: 'anthropic',
        access: tokens.access,
        refresh: tokens.refresh ?? '',
        expires: tokens.expires,
      });

      console.log('Successfully logged in!');
    } else if (provider === 'minimax') {
      // Build authorization URL
      const authUrl = buildMiniMaxUrl('orca-cli', 'http://localhost:9999/callback');
      console.log(`Please visit: ${authUrl}`);
      await openBrowser(authUrl);

      console.log('After authorizing, you will be redirected to a callback URL.');
      console.log('Copy the authorization code from the URL and paste it here:');
      const code = await promptForCode();

      // Note: In a full implementation, we'd exchange the code for tokens
      // For now, this is a placeholder
      console.log('MiniMax OAuth flow requires server callback - this is a placeholder.');
    } else {
      console.error(`Unsupported provider: ${provider}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

async function logout(profileId?: string): Promise<void> {
  const profiles = profileId ? [profileId] : listAuthProfiles();

  if (profiles.length === 0) {
    console.log('No auth profiles found.');
    return;
  }

  for (const id of profiles) {
    if (deleteAuthProfile(id)) {
      console.log(`Logged out: ${id}`);
    }
  }
}

async function auth(showDoctor: boolean = false): Promise<void> {
  const profiles = listAuthProfiles();

  if (profiles.length === 0) {
    console.log('No auth profiles configured.');
    console.log('Run "orca login" to set up authentication.');
    return;
  }

  console.log('Auth profiles:');
  for (const profileId of profiles) {
    const profile = getAuthProfile(profileId);
    if (!profile) continue;

    const status = profile.mode === 'oauth' && profile.expires
      ? (Date.now() < profile.expires ? 'valid' : 'expired')
      : 'valid';

    console.log(`  ${profileId}:`);
    console.log(`    provider: ${profile.provider}`);
    console.log(`    mode: ${profile.mode}`);
    console.log(`    status: ${status}`);
    if (profile.email) {
      console.log(`    email: ${profile.email}`);
    }
  }

  // Try to get a valid token for the default profile
  const defaultCreds = await getValidAccessToken('default');
  if (defaultCreds) {
    console.log('\nDefault profile is ready to use.');
  } else if (profiles.includes('default')) {
    console.log('\nDefault profile needs re-authentication. Run "orca login".');
  }
}

function formatErrors(errors: { code: string; message: string; severity: string; suggestion?: string }[]): void {
  for (const err of errors) {
    const prefix = err.severity === 'error' ? 'ERROR' : 'WARN';
    console.log(`[${prefix}] ${err.code}: ${err.message}`);
    if (err.suggestion) {
      console.log(`  Suggestion: ${err.suggestion}`);
    }
  }
}

function stripCodeFence(code: string): string {
  return code
    .replace(/^```typescript\n/, '')
    .replace(/^```\n/, '')
    .replace(/\n```$/, '')
    .trim();
}

async function verify(input: SkillInput, json: boolean = false): Promise<void> {
  if (json) {
    const result = await verifySkill(input);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.status === 'valid' ? 0 : 1);
  }

  const label = input.file ?? '<stdin>';
  console.log(`Verifying ${label}...`);
  const source = sourceFromInput(input);
  const { file } = parseMarkdown(source);

  if (file.machines.length > 1) {
    // Multi-machine verification
    const fileAnalysis = analyzeFile(file);
    console.log(`Parsed ${file.machines.length} machines:`);
    for (const machine of file.machines) {
      console.log(`  - ${machine.name}`);
    }

    const allErrors = [...fileAnalysis.errors];
    const allWarnings = [...fileAnalysis.warnings];

    if (allErrors.length > 0) {
      const errorCount = allErrors.filter(e => e.severity === 'error').length;
      const warningCount = allErrors.filter(e => e.severity === 'warning').length + allWarnings.length;
      console.log(`\nFound ${errorCount} error(s)${warningCount > 0 ? ` and ${warningCount} warning(s)` : ''}:`);
      formatErrors([...allErrors, ...allWarnings]);
      process.exit(1);
    } else {
      console.log('\nVerification passed!');
    }
    return;
  }

  // Single-machine verification
  const machine = file.machines[0];
  console.log(`Parsed machine: ${machine.name}`);
  console.log(`  States: ${machine.states.length}`);
  console.log(`  Events: ${machine.events.length}`);
  console.log(`  Transitions: ${machine.transitions.length}`);

  const structural = checkStructural(machine);
  const completeness = checkCompleteness(machine);
  const determinism = checkDeterminism(machine);
  const properties = checkProperties(machine);

  const allErrors = [
    ...structural.errors,
    ...completeness.errors,
    ...determinism.errors,
    ...properties.errors,
  ];

  if (allErrors.length > 0) {
    const errorCount = allErrors.filter(e => e.severity === 'error').length;
    const warningCount = allErrors.filter(e => e.severity === 'warning').length;
    if (errorCount > 0) {
      console.log(`\nFound ${errorCount} error(s)${warningCount > 0 ? ` and ${warningCount} warning(s)` : ''}:`);
    } else {
      console.log(`\nFound ${warningCount} warning(s):`);
    }
    formatErrors(allErrors);
    if (errorCount > 0) process.exit(1);
  } else {
    const propCount = machine.properties?.length ?? 0;
    if (propCount > 0) {
      console.log(`\nVerification passed! (${propCount} properties checked)`);
    } else {
      console.log('\nVerification passed!');
    }
  }
}

async function compileXState(input: SkillInput, json: boolean = false): Promise<void> {
  if (json) {
    const result = await compileSkill(input, 'xstate');
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const source = sourceFromInput(input);
  const { file } = parseMarkdown(source);
  if (file.machines.length > 1) {
    console.error('Multi-machine XState compilation not yet fully implemented. Compiling first machine only.');
  }
  const machine = file.machines[0];
  const output = compileToXState(machine);
  console.log(output);
}

async function compileMermaid(input: SkillInput, json: boolean = false): Promise<void> {
  if (json) {
    const result = await compileSkill(input, 'mermaid');
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const source = sourceFromInput(input);
  const machine = parseFile(input.file ?? '<stdin>', source);
  const output = compileToMermaid(machine);
  console.log(output);
}

async function visualize(input: SkillInput): Promise<void> {
  const source = sourceFromInput(input);
  const machine = parseFile(input.file ?? '<stdin>', source);
  const mermaid = compileToMermaid(machine);
  console.log('Mermaid diagram:');
  console.log(mermaid);
  console.log('\nYou can render this at: https://mermaid.live');
}

function langExt(language: string): { src: string; test: string; testSuffix: string } {
  switch (language) {
    case 'python': return { src: '.py', test: '_test.py', testSuffix: '.py' };
    case 'go':     return { src: '.go', test: '_test.go', testSuffix: '.go' };
    default:       return { src: '.ts', test: '.test.ts', testSuffix: '.ts' };
  }
}

async function generateActions(input: SkillInput, language: string, json: boolean = false, useLLM: boolean = false, outputPath?: string, generateTests: boolean = false): Promise<void> {
  const result = await generateActionsSkill(input, language, useLLM, undefined, generateTests);
  const ext = langExt(language);

  if (outputPath) {
    // Write scaffolds to output directory or file
    const isDir = outputPath.endsWith('/') || !outputPath.includes('.');
    if (isDir) {
      if (!existsSync(outputPath)) {
        mkdirSync(outputPath, { recursive: true });
      }
      for (const [name, scaffold] of Object.entries(result.scaffolds)) {
        const fileName = `${name}${ext.src}`;
        const code = stripCodeFence(scaffold);
        writeFileSync(join(outputPath, fileName), code);
        console.log(`Wrote: ${join(outputPath, fileName)}`);
      }
      if (result.tests) {
        for (const [name, test] of Object.entries(result.tests)) {
          const fileName = `${name}${ext.test}`;
          const code = stripCodeFence(test);
          writeFileSync(join(outputPath, fileName), code);
          console.log(`Wrote: ${join(outputPath, fileName)}`);
        }
      }
    } else {
      // Combine all scaffolds into single file
      const combined = Object.entries(result.scaffolds)
        .map(([name, scaffold]) => stripCodeFence(scaffold))
        .join('\n\n');
      writeFileSync(outputPath, combined);
      console.log(`Wrote: ${outputPath}`);

      if (result.tests) {
        const dotIdx = outputPath.lastIndexOf('.');
        const testPath = dotIdx !== -1
          ? outputPath.slice(0, dotIdx) + ext.test
          : outputPath + ext.test;
        const testCombined = Object.entries(result.tests)
          .map(([_, test]) => stripCodeFence(test))
          .join('\n\n');
        writeFileSync(testPath, testCombined);
        console.log(`Wrote: ${testPath}`);
      }
    }
    return;
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Generated action scaffolds for ${result.machine}:`);
  for (const [name, scaffold] of Object.entries(result.scaffolds)) {
    console.log(`\n--- ${name} ---`);
    console.log(scaffold);
    if (result.tests?.[name]) {
      console.log(`\n--- ${name} Tests ---`);
      console.log(result.tests[name]);
    }
  }
}

async function refine(input: SkillInput, errorsJson: string, json: boolean = false): Promise<void> {
  const errors = JSON.parse(errorsJson);
  const result = await refineSkill(input, errors);

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.status === 'requires_refinement') {
    console.error(`Refinement incomplete after ${result.iterations} iteration(s). Remaining errors:`);
    for (const e of result.verification?.errors ?? []) {
      console.error(`  [${e.severity.toUpperCase()}] ${e.code}: ${e.message}`);
    }
    console.log(result.corrected);
    process.exit(1);
  } else if (result.status === 'error') {
    console.error(`Refinement failed: ${result.error}`);
    process.exit(1);
  } else {
    console.log(result.corrected);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Orca CLI');
    console.log('Usage:');
    console.log('  orca verify [--json] <file.orca> [--stdin]          - Parse and verify a machine');
    console.log('  orca compile [--json] xstate <file.orca> [--stdin]  - Compile to XState v5');
    console.log('  orca compile [--json] mermaid <file.orca> [--stdin] - Compile to Mermaid diagram');
    console.log('  orca visualize <file.orca> [--stdin]                - Compile and show Mermaid');
    console.log('  orca actions [--json] [--lang <lang>] [--output <path>] [--tests] <file.orca> [--stdin]');
    console.log('  orca --tools --json                                 - List all tools as JSON');
    console.log('');
    console.log('Auth commands:');
    console.log('  orca login [--provider <provider>] [--profile <id>]  - Login to an LLM provider');
    console.log('  orca logout [--profile <id>]                        - Remove auth credentials');
    console.log('  orca auth [--doctor]                                - Show auth status');
    console.log('');
    console.log('Skills (LLM-friendly):');
    console.log('  orca /parse-machine [<file.orca.md>] [--stdin]      - Parse and return AST as JSON');
    console.log('  orca /verify-orca [<file.orca>] [--stdin]           - Structured JSON verification');
    console.log('  orca /compile-orca [target] [<file.orca>] [--stdin] - Structured JSON compilation');
    console.log('  orca /generate-orca "spec" [--output=<file.orca>]         - Generate Orca from natural language');
    console.log('  orca /generate-orca-multi "spec" [--output=<file.orca.md>] - Generate coordinated multi-machine Orca');
    console.log('  orca /generate-actions [--use-llm] [--lang <lang>] [--output <path>] [--tests] [<file>] [--stdin]');
    console.log('  orca /refine-orca [<file.orca>] [--stdin]                 - Fix verification errors (requires LLM)');
    process.exit(1);
  }

  // Handle auth commands (before stdin/tools processing)
  if (args[0] === 'login') {
    let provider = 'anthropic';
    let profileId = 'default';
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--provider' && args[i + 1]) provider = args[++i];
      if (args[i] === '--profile' && args[i + 1]) profileId = args[++i];
    }
    await login(provider, profileId);
    return;
  }

  if (args[0] === 'logout') {
    let profileId: string | undefined;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--profile' && args[i + 1]) profileId = args[++i];
    }
    await logout(profileId);
    return;
  }

  if (args[0] === 'auth') {
    await auth(args.includes('--doctor'));
    return;
  }

  // B3: tool discovery
  if (args[0] === '--tools' && args[1] === '--json') {
    console.log(JSON.stringify(ORCA_TOOLS, null, 2));
    return;
  }

  // B2: strip --stdin from arg list
  const useStdin = args.includes('--stdin');
  const cleanArgs = args.filter(a => a !== '--stdin');

  // Check for skill invocations (starting with /)
  if (cleanArgs[0].startsWith('/')) {
    const skill = cleanArgs[0];
    const skillArgs = cleanArgs.slice(1);

    if (skill === '/parse-machine') {
      const fileArg = skillArgs.find(a => !a.startsWith('-'));
      const input = await getInput(fileArg, useStdin);
      const result = parseSkill(input);
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.status === 'success' ? 0 : 1);
    }

    if (skill === '/verify-orca') {
      const fileArg = skillArgs.find(a => !a.startsWith('-'));
      const input = await getInput(fileArg, useStdin);
      const result = await verifySkill(input);
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.status === 'valid' ? 0 : 1);
    }

    if (skill === '/compile-orca') {
      const isTarget = (s: string) => s === 'xstate' || s === 'mermaid';
      const target = (skillArgs.find(isTarget) as 'xstate' | 'mermaid') ?? 'xstate';
      const fileArg = skillArgs.find(a => !a.startsWith('-') && !isTarget(a));
      const input = await getInput(fileArg, useStdin);
      const result = await compileSkill(input, target);
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (skill === '/generate-actions') {
      let useLLM = false;
      let generateTests = false;
      let lang = 'typescript';
      let outputPath: string | undefined;
      let fileArg: string | undefined;

      for (let i = 0; i < skillArgs.length; i++) {
        const arg = skillArgs[i];
        if (arg === '--use-llm') useLLM = true;
        if (arg === '--tests') generateTests = true;
        if (arg === '--lang' && skillArgs[i + 1]) lang = skillArgs[++i];
        if ((arg === '--output' || arg === '-o') && skillArgs[i + 1]) outputPath = skillArgs[++i];
        if (arg?.endsWith('.orca') || arg?.endsWith('.orca.md')) fileArg = arg;
      }

      const input = await getInput(fileArg, useStdin);
      await generateActions(input, lang, false, useLLM, outputPath, generateTests);
      return;
    }

    if (skill === '/refine-orca') {
      const fileArg = skillArgs.find(a => a.endsWith('.orca') || a.endsWith('.orca.md'));
      const errorsJson = skillArgs.find(a => a.startsWith('[')) || '[]';
      const input = await getInput(fileArg, useStdin);
      const result = await refineSkill(input, JSON.parse(errorsJson));
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (skill === '/generate-orca') {
      const spec = skillArgs[0] || skillArgs.find(a => !a.startsWith('--')) || '';
      const outputPath = skillArgs.find(a => a.startsWith('--output='))?.replace('--output=', '') ||
                         skillArgs.find(a => a.startsWith('-o='))?.replace('-o=', '');

      if (!spec) {
        console.error('Usage: /generate-orca "natural language specification" [--output=<file.orca>]');
        process.exit(1);
      }

      const result = await generateOrcaSkill(spec);

      if (result.status === 'success' && result.orca) {
        if (outputPath) {
          writeFileSync(outputPath, result.orca);
          console.log(`Generated: ${outputPath}`);
        } else {
          console.log(result.orca);
        }
      } else if (result.status === 'requires_refinement' && result.orca) {
        console.log('Machine generated but verification found issues. Outputting for manual review:');
        console.log(result.orca);
        if (result.verification?.errors.length) {
          console.log('\nVerification issues:');
          for (const err of result.verification.errors) {
            console.log(`  [${err.severity.toUpperCase()}] ${err.code}: ${err.message}`);
            if (err.suggestion) console.log(`    Suggestion: ${err.suggestion}`);
          }
        }
      } else {
        console.error(`Generation failed: ${result.error}`);
        process.exit(1);
      }
      return;
    }

    if (skill === '/generate-orca-multi') {
      const spec = skillArgs[0] || skillArgs.find(a => !a.startsWith('--')) || '';
      const outputPath = skillArgs.find(a => a.startsWith('--output='))?.replace('--output=', '') ||
                         skillArgs.find(a => a.startsWith('-o='))?.replace('-o=', '');

      if (!spec) {
        console.error('Usage: /generate-orca-multi "natural language specification" [--output=<file.orca.md>]');
        process.exit(1);
      }

      const result = await generateOrcaMultiSkill(spec);

      if (result.status === 'success' && result.orca) {
        if (outputPath) {
          writeFileSync(outputPath, result.orca);
          console.log(`Generated: ${outputPath} (machines: ${result.machines?.join(', ')})`);
        } else {
          console.log(result.orca);
        }
      } else if (result.status === 'requires_refinement' && result.orca) {
        console.log('Machines generated but verification found issues. Outputting for manual review:');
        console.log(result.orca);
        if (result.errors?.length) {
          console.log('\nVerification issues:');
          for (const err of result.errors) {
            console.log(`  [${err.severity.toUpperCase()}] ${err.code}: ${err.message}`);
            if (err.suggestion) console.log(`    Suggestion: ${err.suggestion}`);
          }
        }
      } else {
        console.error(`Generation failed: ${result.error}`);
        process.exit(1);
      }
      return;
    }

    console.error(`Unknown skill: ${skill}`);
    process.exit(1);
  }

  // Standard commands
  const command = cleanArgs[0];

  // Check for --json flag
  let json = false;
  let filteredArgs = cleanArgs;
  if (cleanArgs[1] === '--json') {
    json = true;
    filteredArgs = [cleanArgs[0], ...cleanArgs.slice(2)];
  }

  try {
    if (command === 'verify') {
      const input = await getInput(filteredArgs[1], useStdin);
      await verify(input, json);
    } else if (command === 'compile' && filteredArgs[1] === 'xstate') {
      const input = await getInput(filteredArgs[2], useStdin);
      await compileXState(input, json);
    } else if (command === 'compile' && filteredArgs[1] === 'mermaid') {
      const input = await getInput(filteredArgs[2], useStdin);
      await compileMermaid(input, json);
    } else if (command === 'visualize') {
      const input = await getInput(filteredArgs[1], useStdin);
      await visualize(input);
    } else if (command === 'convert') {
      const inputPath = filteredArgs[1];
      if (!inputPath) {
        console.error('Usage: orca convert <input.orca> [-o <output.orca.md>]');
        process.exit(1);
      }
      const outputIdx = filteredArgs.indexOf('-o');
      const outputPath = outputIdx !== -1 ? filteredArgs[outputIdx + 1] : inputPath.replace(/\.orca$/, '.orca.md');
      const source = readFileSync(inputPath, 'utf-8');
      const machine = parseFile(inputPath, source);
      const md = machineToMarkdown(machine);
      writeFileSync(outputPath, md);
      console.log(`Converted: ${inputPath} -> ${outputPath}`);
      // Verify round-trip
      const roundTrip = parseMarkdown(md).file.machines[0];
      console.log(`Round-trip verification: ${JSON.stringify(machine) === JSON.stringify(roundTrip) ? 'PASS' : 'WARN: ASTs differ'}`);
    } else if (command === 'actions') {
      let lang = 'typescript';
      let useLLM = false;
      let generateTests = false;
      let outputPath: string | undefined;
      let fileArg: string | undefined;
      for (let i = 1; i < filteredArgs.length; i++) {
        if (filteredArgs[i] === '--lang' && filteredArgs[i + 1]) lang = filteredArgs[++i];
        if ((filteredArgs[i] === '--output' || filteredArgs[i] === '-o') && filteredArgs[i + 1]) outputPath = filteredArgs[++i];
        if (filteredArgs[i] === '--use-llm') useLLM = true;
        if (filteredArgs[i] === '--tests') generateTests = true;
        if (filteredArgs[i]?.endsWith('.orca') || filteredArgs[i]?.endsWith('.orca.md')) fileArg = filteredArgs[i];
      }
      if (!fileArg) fileArg = filteredArgs[filteredArgs.length - 1];
      const input = await getInput(fileArg === command ? undefined : fileArg, useStdin);
      await generateActions(input, lang, json, useLLM, outputPath, generateTests);
    } else {
      console.error(`Unknown command: ${command}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

// Only run main() when this file is executed directly (not imported as a module)
// In ESM, we check if this module is the main entry point
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && process.argv[1].endsWith(__filename)) {
  main();
}
