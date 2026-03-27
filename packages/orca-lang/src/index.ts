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
import { verifySkill, compileSkill, generateActionsSkill, refineSkill, generateOrcaSkill } from './skills.js';
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

async function verify(filePath: string, json: boolean = false): Promise<void> {
  if (json) {
    const result = await verifySkill(filePath);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.status === 'valid' ? 0 : 1);
  }

  console.log(`Verifying ${filePath}...`);
  const source = readFileSync(filePath, 'utf-8');
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

async function compileXState(filePath: string, json: boolean = false): Promise<void> {
  if (json) {
    const result = await compileSkill(filePath, 'xstate');
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const source = readFileSync(filePath, 'utf-8');
  const { file } = parseMarkdown(source);
  if (file.machines.length > 1) {
    console.error('Multi-machine XState compilation not yet fully implemented. Compiling first machine only.');
  }
  const machine = file.machines[0];
  const output = compileToXState(machine);
  console.log(output);
}

async function compileMermaid(filePath: string, json: boolean = false): Promise<void> {
  if (json) {
    const result = await compileSkill(filePath, 'mermaid');
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const source = readFileSync(filePath, 'utf-8');
  const machine = parseFile(filePath, source);
  const output = compileToMermaid(machine);
  console.log(output);
}

async function visualize(filePath: string): Promise<void> {
  const source = readFileSync(filePath, 'utf-8');
  const machine = parseFile(filePath, source);
  const mermaid = compileToMermaid(machine);
  console.log('Mermaid diagram:');
  console.log(mermaid);
  console.log('\nYou can render this at: https://mermaid.live');
}

async function generateActions(filePath: string, language: string, json: boolean = false, useLLM: boolean = false, outputPath?: string, generateTests: boolean = false): Promise<void> {
  const result = await generateActionsSkill(filePath, language, useLLM, undefined, generateTests);

  if (outputPath) {
    // Write scaffolds to output directory or file
    const isDir = outputPath.endsWith('/') || !outputPath.includes('.');
    if (isDir) {
      if (!existsSync(outputPath)) {
        mkdirSync(outputPath, { recursive: true });
      }
      for (const [name, scaffold] of Object.entries(result.scaffolds)) {
        const fileName = `${name}.ts`;
        const code = stripCodeFence(scaffold);
        writeFileSync(join(outputPath, fileName), code);
        console.log(`Wrote: ${join(outputPath, fileName)}`);
      }
      // Write tests alongside action files
      if (result.tests) {
        for (const [name, test] of Object.entries(result.tests)) {
          const fileName = `${name}.test.ts`;
          const code = stripCodeFence(test);
          writeFileSync(join(outputPath, fileName), code);
          console.log(`Wrote: ${join(outputPath, fileName)}`);
        }
      }
    } else {
      // Combine all scaffolds into single file
      const combined = Object.entries(result.scaffolds)
        .map(([name, scaffold]) => `// ${name}\n${stripCodeFence(scaffold)}`)
        .join('\n\n');
      writeFileSync(outputPath, combined);
      console.log(`Wrote: ${outputPath}`);

      // Write tests to a separate file
      if (result.tests) {
        const testPath = outputPath.replace('.ts', '.test.ts');
        const testCombined = Object.entries(result.tests)
          .map(([name, test]) => `// Tests for ${name}\n${stripCodeFence(test)}`)
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

async function refine(filePath: string, errorsJson: string, json: boolean = false): Promise<void> {
  const errors = JSON.parse(errorsJson);
  const result = await refineSkill(filePath, errors);

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.status === 'requires_llm') {
    console.log(result.changes.join('\n'));
  } else {
    console.log(result.corrected);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Orca CLI');
    console.log('Usage:');
    console.log('  orca verify [--json] <file.orca>              - Parse and verify a machine');
    console.log('  orca compile [--json] xstate <file.orca>      - Compile to XState v5');
    console.log('  orca compile [--json] mermaid <file.orca>     - Compile to Mermaid diagram');
    console.log('  orca visualize <file.orca>                   - Compile and show Mermaid');
    console.log('  orca actions [--json] [--lang <lang>] [--output <path>] [--tests] <file.orca>  - Generate action scaffolds');
    console.log('');
    console.log('Auth commands:');
    console.log('  orca login [--provider <provider>] [--profile <id>]  - Login to an LLM provider');
    console.log('  orca logout [--profile <id>]                       - Remove auth credentials');
    console.log('  orca auth [--doctor]                               - Show auth status');
    console.log('');
    console.log('Skills (LLM-friendly):');
    console.log('  orca /verify-orca <file.orca>    - Structured JSON verification');
    console.log('  orca /compile-orca [target] <file.orca>   - Structured JSON compilation');
    console.log('  orca /generate-orca "spec" [--output=<file.orca>]  - Generate Orca from natural language');
    console.log('  orca /generate-actions [--use-llm] [--lang <lang>] [--output <path>] [--tests] <file.orca>  - Generate action scaffolds');
    console.log('  orca /refine-orca <file.orca>    - Fix verification errors (requires LLM)');
    process.exit(1);
  }

  // Handle auth commands
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

  // Check for skill invocations (starting with /)
  if (args[0].startsWith('/')) {
    const skill = args[0];
    const skillArgs = args.slice(1);

    if (skill === '/verify-orca') {
      const result = await verifySkill(skillArgs[0]);
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.status === 'valid' ? 0 : 1);
    }

    if (skill === '/compile-orca') {
      const target = (skillArgs[0] as 'xstate' | 'mermaid') || 'xstate';
      const filePath = skillArgs[1] || skillArgs[0];
      const result = await compileSkill(filePath, target);
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (skill === '/generate-actions') {
      let useLLM = false;
      let generateTests = false;
      let lang = 'typescript';
      let outputPath: string | undefined;
      let filePath = skillArgs[0];

      for (let i = 0; i < skillArgs.length; i++) {
        const arg = skillArgs[i];
        if (arg === '--use-llm') useLLM = true;
        if (arg === '--tests') generateTests = true;
        if (arg === '--lang' && skillArgs[i + 1]) lang = skillArgs[++i];
        if ((arg === '--output' || arg === '-o') && skillArgs[i + 1]) outputPath = skillArgs[++i];
        if (arg?.endsWith('.orca') || arg?.endsWith('.orca.md')) filePath = arg;
      }

      await generateActions(filePath, lang, false, useLLM, outputPath, generateTests);
      return;
    }

    if (skill === '/refine-orca') {
      const filePath = skillArgs[0];
      const errorsJson = skillArgs.find(a => a.startsWith('[')) || '[]';
      const result = await refineSkill(filePath, JSON.parse(errorsJson));
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (skill === '/generate-orca') {
      // /generate-orca "natural language description"
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

    console.error(`Unknown skill: ${skill}`);
    process.exit(1);
  }

  // Standard commands
  const command = args[0];

  // Check for --json flag
  let json = false;
  let filteredArgs = args;
  if (args[1] === '--json') {
    json = true;
    filteredArgs = [args[0], ...args.slice(2)];
  }

  try {
    if (command === 'verify') {
      await verify(filteredArgs[1] || filteredArgs[0], json);
    } else if (command === 'compile' && filteredArgs[1] === 'xstate') {
      await compileXState(filteredArgs[2] || filteredArgs[1], json);
    } else if (command === 'compile' && filteredArgs[1] === 'mermaid') {
      await compileMermaid(filteredArgs[2] || filteredArgs[1], json);
    } else if (command === 'visualize') {
      await visualize(filteredArgs[1] || filteredArgs[0]);
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
      let filePath = filteredArgs[filteredArgs.length - 1];
      for (let i = 1; i < filteredArgs.length; i++) {
        if (filteredArgs[i] === '--lang' && filteredArgs[i + 1]) lang = filteredArgs[++i];
        if ((filteredArgs[i] === '--output' || filteredArgs[i] === '-o') && filteredArgs[i + 1]) outputPath = filteredArgs[++i];
        if (filteredArgs[i] === '--use-llm') useLLM = true;
        if (filteredArgs[i] === '--tests') generateTests = true;
      }
      await generateActions(filePath || filteredArgs[1], lang, json, useLLM, outputPath, generateTests);
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
