/**
 * Runs a StepImplementer Orca machine to implement a single phase step.
 *
 * The StepImplementer machine drives itself:
 *   idle -> gathering_context -> generating_changes -> applying_changes -> running_tests -> done
 *
 * Action handlers capture the machine reference via closure and call machine.send()
 * to progress the state machine after completing their async work.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseOrcaAuto, OrcaMachine, EventBus } from '@orcalang/orca-runtime-ts';
import type { StateValue } from '@orcalang/orca-runtime-ts';
import { gatherContextFiles, generateFileChanges } from './effects/llm.js';
import { readContextFiles, applyFileChanges } from './effects/filesystem.js';
import { runTests } from './effects/shell.js';
import type { PhaseStep, FileChange, StepResult } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const STEP_IMPLEMENTER_SOURCE = readFileSync(
  join(__dirname, '..', 'orca', 'step-implementer.orca.md'),
  'utf-8'
);

/**
 * Run the StepImplementer machine for a single step.
 * Returns when the machine reaches 'done' or 'failed'.
 */
export async function runStepImplementer(
  step: PhaseStep,
  repoRoot: string,
  dryRun: boolean
): Promise<StepResult> {
  const bus = new EventBus();
  const def = parseOrcaAuto(STEP_IMPLEMENTER_SOURCE);

  // Shared result object populated by action handlers
  const result: { changes: FileChange[]; commitMessage: string } = {
    changes: [],
    commitMessage: '',
  };

  let resolved = false;

  return new Promise<StepResult>((resolve) => {
    const machine = new OrcaMachine(
      def,
      bus,
      {
        step: step as unknown as Record<string, unknown>,
        repo_root: repoRoot,
        dry_run: dryRun,
        context_files: [],
        file_changes: [],
        test_output: '',
        retry_count: 0,
        commit_message: '',
        error: '',
      },
      async (_from: StateValue, to: StateValue) => {
        if (resolved) return;
        const stateName = to.toString();
        if (stateName === 'done') {
          resolved = true;
          resolve({
            status: 'done',
            changes: result.changes,
            commitMessage: result.commitMessage,
          });
        } else if (stateName === 'failed') {
          resolved = true;
          const snap = machine.snapshot();
          resolve({
            status: 'failed',
            error: (snap.context.error as string) || 'Step implementation failed',
          });
        }
      }
    );

    // --- Action: gather_context ---
    machine.registerAction('gather_context', async (ctx) => {
      try {
        console.log(`  [gather_context] identifying relevant files...`);
        const step = ctx.step as PhaseStep;
        const repoRoot = ctx.repo_root as string;

        const filePaths = await gatherContextFiles(step, repoRoot);
        console.log(`  [gather_context] reading ${filePaths.length} files`);
        const contextFiles = readContextFiles(filePaths, repoRoot);

        await machine.send('context_ready');
        return { context_files: contextFiles as unknown as Record<string, unknown>[] };
      } catch (err) {
        await machine.send('fail', { error: String(err) });
        return { error: String(err) };
      }
    });

    // --- Action: generate_changes ---
    machine.registerAction('generate_changes', async (ctx) => {
      try {
        console.log(`  [generate_changes] calling LLM...`);
        const step = ctx.step as PhaseStep;
        const contextFiles = ctx.context_files as Array<{ path: string; content: string }>;
        const testOutput = ctx.test_output as string | undefined;

        const response = await generateFileChanges(step, contextFiles, testOutput);
        console.log(`  [generate_changes] ${response.files.length} file(s) to change`);
        console.log(`  [generate_changes] ${response.explanation}`);

        result.changes = response.files;
        result.commitMessage = response.commit_message;

        await machine.send('changes_ready');
        return {
          file_changes: response.files as unknown as Record<string, unknown>[],
          commit_message: response.commit_message,
        };
      } catch (err) {
        await machine.send('fail', { error: String(err) });
        return { error: String(err) };
      }
    });

    // --- Action: apply_changes ---
    machine.registerAction('apply_changes', async (ctx) => {
      try {
        const changes = ctx.file_changes as FileChange[];
        const repoRoot = ctx.repo_root as string;
        const dryRun = ctx.dry_run as boolean;

        if (dryRun) {
          console.log(`  [apply_changes] DRY RUN — would apply ${changes.length} file(s):`);
          for (const c of changes) {
            console.log(`    ${c.operation}: ${c.path}`);
          }
        } else {
          console.log(`  [apply_changes] applying ${changes.length} file(s)...`);
          applyFileChanges(changes, repoRoot);
        }

        await machine.send('changes_applied');
        return {};
      } catch (err) {
        await machine.send('fail', { error: String(err) });
        return { error: String(err) };
      }
    });

    // --- Action: run_tests ---
    machine.registerAction('run_tests', async (ctx) => {
      const repoRoot = ctx.repo_root as string;
      const dryRun = ctx.dry_run as boolean;

      if (dryRun) {
        console.log(`  [run_tests] DRY RUN — skipping tests`);
        await machine.send('tests_passed');
        return {};
      }

      console.log(`  [run_tests] running pnpm test...`);
      const testResult = runTests(repoRoot);

      if (testResult.passed) {
        console.log(`  [run_tests] PASSED`);
        await machine.send('tests_passed');
      } else {
        const retryCount = ctx.retry_count as number;
        console.log(`  [run_tests] FAILED (retry ${retryCount}/2)`);
        await machine.send('tests_failed');
      }

      return { test_output: testResult.output };
    });

    // --- Action: increment_retry ---
    machine.registerAction('increment_retry', (ctx) => {
      return { retry_count: (ctx.retry_count as number) + 1 };
    });

    // --- Action: record_error ---
    machine.registerAction('record_error', (ctx, event) => {
      const error = (event?.error as string) || (ctx.error as string) || 'Unknown error';
      console.error(`  [record_error] ${error}`);
      return { error };
    });

    // Start the machine and send the initial event
    machine.start().then(() => {
      machine.send('start').catch((err: unknown) => {
        if (!resolved) {
          resolved = true;
          resolve({ status: 'failed', error: String(err) });
        }
      });
    });
  });
}
