#!/usr/bin/env node

import { readFileSync } from 'fs';
import { tokenize } from './parser/lexer.js';
import { parse } from './parser/parser.js';
import { checkStructural } from './verifier/structural.js';
import { checkCompleteness } from './verifier/completeness.js';
import { checkDeterminism } from './verifier/determinism.js';
import { compileToXState } from './compiler/xstate.js';
import { compileToMermaid } from './compiler/mermaid.js';
import { verifySkill, compileSkill, generateActionsSkill, refineSkill } from './skills.js';

function formatErrors(errors: { code: string; message: string; severity: string; suggestion?: string }[]): void {
  for (const err of errors) {
    const prefix = err.severity === 'error' ? 'ERROR' : 'WARN';
    console.log(`[${prefix}] ${err.code}: ${err.message}`);
    if (err.suggestion) {
      console.log(`  Suggestion: ${err.suggestion}`);
    }
  }
}

async function verify(filePath: string, json: boolean = false): Promise<void> {
  if (json) {
    const result = await verifySkill(filePath);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.status === 'valid' ? 0 : 1);
  }

  console.log(`Verifying ${filePath}...`);
  const source = readFileSync(filePath, 'utf-8');
  const tokens = tokenize(source);
  const result = parse(tokens);

  console.log(`Parsed machine: ${result.machine.name}`);
  console.log(`  States: ${result.machine.states.length}`);
  console.log(`  Events: ${result.machine.events.length}`);
  console.log(`  Transitions: ${result.machine.transitions.length}`);

  const structural = checkStructural(result.machine);
  const completeness = checkCompleteness(result.machine);
  const determinism = checkDeterminism(result.machine);

  const allErrors = [
    ...structural.errors,
    ...completeness.errors,
    ...determinism.errors,
  ];

  if (allErrors.length > 0) {
    console.log(`\nFound ${allErrors.filter(e => e.severity === 'error').length} errors:`);
    formatErrors(allErrors);
    process.exit(1);
  } else {
    console.log('\nVerification passed!');
  }
}

async function compileXState(filePath: string, json: boolean = false): Promise<void> {
  if (json) {
    const result = await compileSkill(filePath, 'xstate');
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const source = readFileSync(filePath, 'utf-8');
  const tokens = tokenize(source);
  const result = parse(tokens);
  const output = compileToXState(result.machine);
  console.log(output);
}

async function compileMermaid(filePath: string, json: boolean = false): Promise<void> {
  if (json) {
    const result = await compileSkill(filePath, 'mermaid');
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const source = readFileSync(filePath, 'utf-8');
  const tokens = tokenize(source);
  const result = parse(tokens);
  const output = compileToMermaid(result.machine);
  console.log(output);
}

async function visualize(filePath: string): Promise<void> {
  const source = readFileSync(filePath, 'utf-8');
  const tokens = tokenize(source);
  const result = parse(tokens);
  const mermaid = compileToMermaid(result.machine);
  console.log('Mermaid diagram:');
  console.log(mermaid);
  console.log('\nYou can render this at: https://mermaid.live');
}

async function generateActions(filePath: string, language: string, json: boolean = false): Promise<void> {
  const result = await generateActionsSkill(filePath, language);

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Generated action scaffolds for ${result.machine}:`);
  for (const [name, scaffold] of Object.entries(result.scaffolds)) {
    console.log(`\n--- ${name} ---`);
    console.log(scaffold);
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
    console.log('  orca actions [--json] [--lang <lang>] <file.orca>  - Generate action scaffolds');
    console.log('');
    console.log('Skills (LLM-friendly):');
    console.log('  orca /verify-orca <file.orca>    - Structured JSON verification');
    console.log('  orca /compile-orca <file.orca>   - Structured JSON compilation');
    console.log('  orca /generate-actions <file.orca>  - Generate action scaffolds');
    console.log('  orca /refine-orca <file.orca>    - Fix verification errors (requires LLM)');
    process.exit(1);
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
      const lang = skillArgs[0] === '--lang' ? skillArgs[1] : 'typescript';
      const filePath = lang.endsWith('.orca') ? lang : (skillArgs.find(a => a.endsWith('.orca')) || skillArgs[0]);
      const result = await generateActionsSkill(filePath, lang);
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (skill === '/refine-orca') {
      const filePath = skillArgs[0];
      const errorsJson = skillArgs.find(a => a.startsWith('[')) || '[]';
      const result = await refineSkill(filePath, JSON.parse(errorsJson));
      console.log(JSON.stringify(result, null, 2));
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
    } else if (command === 'actions') {
      let lang = 'typescript';
      let filePath = filteredArgs[filteredArgs.length - 1];
      if (filteredArgs[1] === '--lang' && filteredArgs[2]) {
        lang = filteredArgs[2];
        filePath = filteredArgs[3] || filteredArgs[1];
      }
      await generateActions(filePath || filteredArgs[1], lang, json);
    } else {
      console.error(`Unknown command: ${command}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main();
