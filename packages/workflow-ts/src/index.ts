#!/usr/bin/env tsx
/**
 * orca-workflow CLI
 *
 * Implements Orca phase document steps using an LLM.
 *
 * Usage:
 *   tsx src/index.ts --phase docs/phase-5-agent-adoption.md
 *   tsx src/index.ts --phase docs/phase-5-agent-adoption.md --step 5.1
 *   tsx src/index.ts --phase docs/phase-5-agent-adoption.md --dry-run
 *   tsx src/index.ts --phase docs/phase-5-agent-adoption.md --step 5.1 --dry-run
 */

import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { runOrchestrator } from './run-orchestrator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function parseArgs(argv: string[]): {
  phaseFile?: string;
  step?: string;
  dryRun: boolean;
  repoRoot?: string;
  help: boolean;
} {
  const args = argv.slice(2);
  const opts = { dryRun: false, help: false } as ReturnType<typeof parseArgs>;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--phase' && args[i + 1]) {
      opts.phaseFile = args[++i];
    } else if (arg === '--step' && args[i + 1]) {
      opts.step = args[++i];
    } else if (arg === '--repo-root' && args[i + 1]) {
      opts.repoRoot = args[++i];
    }
  }

  return opts;
}

function printUsage(): void {
  console.log(`
orca-workflow — implement Orca phase steps using an AI agent

Usage:
  tsx src/index.ts --phase <path>            Implement all steps in phase doc
  tsx src/index.ts --phase <path> --step 5.1 Implement only step 5.1
  tsx src/index.ts --phase <path> --dry-run  Preview without writing files

Options:
  --phase <path>     Path to the phase document (.md)
  --step  <id>       Only implement the given step ID (e.g., 5.1)
  --dry-run          Show what would be done without writing files or committing
  --repo-root <path> Path to the repo root (default: auto-detect from CLAUDE.md)
  --help             Show this help

Auth:
  Set ANTHROPIC_API_KEY or run: orca auth login
`);
}

function findRepoRoot(startFrom: string): string {
  // Walk up from the current directory to find CLAUDE.md
  let dir = startFrom;
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, 'CLAUDE.md'))) {
      return dir;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  // Default to the parent of workflow-ts (the monorepo root)
  return resolve(__dirname, '..', '..', '..');
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);

  if (opts.help || !opts.phaseFile) {
    printUsage();
    if (!opts.phaseFile) {
      console.error('Error: --phase is required\n');
      process.exit(1);
    }
    return;
  }

  const phaseFile = resolve(process.cwd(), opts.phaseFile);
  if (!existsSync(phaseFile)) {
    console.error(`Phase file not found: ${phaseFile}`);
    process.exit(1);
  }

  const repoRoot = opts.repoRoot
    ? resolve(process.cwd(), opts.repoRoot)
    : findRepoRoot(process.cwd());

  try {
    await runOrchestrator({
      phaseFile,
      repoRoot,
      dryRun: opts.dryRun,
      filterStep: opts.step,
    });
  } catch (err) {
    console.error(`\nWorkflow failed: ${String(err)}`);
    process.exit(1);
  }
}

main();
