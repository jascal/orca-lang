/**
 * Runs the PhaseOrchestrator Orca machine.
 *
 * The orchestrator:
 *   1. Loads and parses a phase document to extract implementation steps
 *   2. For each step (or a filtered single step): runs the StepImplementer
 *   3. Commits each successfully implemented step
 *   4. Creates a PR when all steps are done
 *
 * Action handlers capture the machine via closure and call machine.send().
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseOrcaAuto, OrcaMachine, EventBus } from '@orcalang/orca-runtime-ts';
import type { StateValue } from '@orcalang/orca-runtime-ts';
import { readPhaseDoc } from './effects/filesystem.js';
import { gitCommit, gitHasChanges } from './effects/shell.js';
import { createPullRequest } from './effects/github.js';
import { parsePhaseDoc } from './parse-phase-doc.js';
import { runStepImplementer } from './run-step.js';
import type { PhaseStep, FileChange, OrchestratorOptions } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ORCHESTRATOR_SOURCE = readFileSync(
  join(__dirname, '..', 'orca', 'orchestrator.orca.md'),
  'utf-8'
);

/**
 * Run the PhaseOrchestrator to implement all (or one) step from a phase document.
 */
export async function runOrchestrator(opts: OrchestratorOptions): Promise<void> {
  const { phaseFile, repoRoot, dryRun = false, filterStep } = opts;

  console.log(`\n=== Orca Workflow ===`);
  console.log(`Phase file: ${phaseFile}`);
  if (filterStep) console.log(`Filter:     step ${filterStep}`);
  if (dryRun) console.log(`Mode:       DRY RUN`);
  console.log('');

  const bus = new EventBus();
  const def = parseOrcaAuto(ORCHESTRATOR_SOURCE);

  let resolved = false;

  return new Promise<void>((resolve, reject) => {
    const machine = new OrcaMachine(
      def,
      bus,
      {
        phase_file: phaseFile,
        steps: [],
        current_step_idx: -1,
        current_step: {},
        dry_run: dryRun,
        filter_step: filterStep ?? '',
        completed_steps: [],
        skipped_steps: [],
        step_changes: [],
        commit_message: '',
        error: '',
        pr_url: '',
      },
      async (_from: StateValue, to: StateValue) => {
        if (resolved) return;
        const stateName = to.toString();
        if (stateName === 'done') {
          resolved = true;
          const snap = machine.snapshot();
          const completed = snap.context.completed_steps as PhaseStep[];
          const prUrl = snap.context.pr_url as string;
          console.log(`\n=== Complete ===`);
          console.log(`Steps implemented: ${completed.length}`);
          if (prUrl) console.log(`PR: ${prUrl}`);
          resolve();
        } else if (stateName === 'failed') {
          resolved = true;
          const snap = machine.snapshot();
          const error = snap.context.error as string;
          console.error(`\n=== Failed ===`);
          console.error(error);
          reject(new Error(error));
        }
      }
    );

    // --- Action: load_phase_doc ---
    machine.registerAction('load_phase_doc', async (ctx) => {
      try {
        const phaseFile = ctx.phase_file as string;
        console.log(`Loading phase document: ${phaseFile}`);

        const source = readPhaseDoc(phaseFile);
        const steps = parsePhaseDoc(source);

        console.log(`Found ${steps.length} step(s)`);

        await machine.send('phase_loaded');
        return { steps: steps as unknown as Record<string, unknown>[] };
      } catch (err) {
        await machine.send('fail', { error: String(err) });
        return { error: String(err) };
      }
    });

    // --- Action: select_next_step ---
    machine.registerAction('select_next_step', async (ctx) => {
      const steps = ctx.steps as PhaseStep[];
      const filterStep = ctx.filter_step as string;
      let idx = (ctx.current_step_idx as number) + 1;

      // Skip steps that don't match the filter
      while (idx < steps.length) {
        const step = steps[idx];
        if (!filterStep || step.id === filterStep) {
          break;
        }
        idx++;
      }

      if (idx >= steps.length) {
        console.log(`All steps processed.`);
        await machine.send('all_steps_done');
        return { current_step_idx: idx };
      }

      const step = steps[idx];
      console.log(`\n--- Step ${step.id}: ${step.title} ---`);

      await machine.send('step_selected');
      return {
        current_step_idx: idx,
        current_step: step as unknown as Record<string, unknown>,
      };
    });

    // --- Action: implement_current_step ---
    machine.registerAction('implement_current_step', async (ctx) => {
      const step = ctx.current_step as PhaseStep;
      const dryRun = ctx.dry_run as boolean;

      console.log(`Implementing step ${step.id}...`);

      try {
        const stepResult = await runStepImplementer(step, repoRoot, dryRun);

        if (stepResult.status === 'done') {
          await machine.send('step_implemented');
          return {
            step_changes: (stepResult.changes ?? []) as unknown as Record<string, unknown>[],
            commit_message: stepResult.commitMessage ?? '',
          };
        } else if (stepResult.status === 'skipped') {
          await machine.send('step_skipped');
          return {};
        } else {
          console.warn(`  Step ${step.id} failed: ${stepResult.error}`);
          await machine.send('fail', { error: stepResult.error });
          return {};
        }
      } catch (err) {
        await machine.send('fail', { error: String(err) });
        return {};
      }
    });

    // --- Action: commit_step ---
    machine.registerAction('commit_step', async (ctx) => {
      const step = ctx.current_step as PhaseStep;
      const commitMessage = ctx.commit_message as string;
      const dryRun = ctx.dry_run as boolean;
      const completedSteps = (ctx.completed_steps as PhaseStep[]) ?? [];

      if (dryRun) {
        console.log(`  [commit] DRY RUN — would commit: "${commitMessage}"`);
        await machine.send('step_committed');
        return {
          completed_steps: [...completedSteps, step] as unknown as Record<string, unknown>[],
        };
      }

      try {
        if (!gitHasChanges(repoRoot)) {
          console.log(`  [commit] no changes to commit for step ${step.id}`);
          await machine.send('step_committed');
          return {
            completed_steps: [...completedSteps, step] as unknown as Record<string, unknown>[],
          };
        }

        const message = commitMessage || `Implement step ${step.id}: ${step.title}`;
        console.log(`  [commit] "${message}"`);
        gitCommit(repoRoot, message);

        await machine.send('step_committed');
        return {
          completed_steps: [...completedSteps, step] as unknown as Record<string, unknown>[],
        };
      } catch (err) {
        await machine.send('fail', { error: String(err) });
        return { error: String(err) };
      }
    });

    // --- Action: create_pr ---
    machine.registerAction('create_pr', async (ctx) => {
      const completedSteps = (ctx.completed_steps as PhaseStep[]) ?? [];
      const dryRun = ctx.dry_run as boolean;

      if (completedSteps.length === 0) {
        console.log(`No steps completed — skipping PR creation`);
        await machine.send('pr_created');
        return {};
      }

      if (dryRun) {
        console.log(`[create_pr] DRY RUN — would create PR for ${completedSteps.length} step(s)`);
        await machine.send('pr_created');
        return {};
      }

      try {
        console.log(`Creating pull request for ${completedSteps.length} step(s)...`);
        const { url } = createPullRequest(repoRoot, completedSteps, 'Phase 6 implementation');
        console.log(`PR created: ${url}`);
        await machine.send('pr_created');
        return { pr_url: url };
      } catch (err) {
        console.warn(`Failed to create PR: ${String(err)}`);
        await machine.send('fail', { error: String(err) });
        return {};
      }
    });

    // --- Action: record_error ---
    machine.registerAction('record_error', (_ctx, event) => {
      const error = (event?.error as string) || 'Unknown error';
      console.error(`Error: ${error}`);
      return { error };
    });

    // --- Action: log_step_failure ---
    machine.registerAction('log_step_failure', (ctx, event) => {
      const step = ctx.current_step as PhaseStep;
      const error = (event?.error as string) || 'Unknown error';
      const skippedSteps = (ctx.skipped_steps as PhaseStep[]) ?? [];
      console.warn(`  Step ${step.id} failed (skipping): ${error}`);
      return {
        skipped_steps: [...skippedSteps, step] as unknown as Record<string, unknown>[],
      };
    });

    // --- Action: log_pr_failure ---
    machine.registerAction('log_pr_failure', (_ctx, event) => {
      const error = (event?.error as string) || 'Unknown error';
      console.warn(`PR creation failed (workflow still succeeded): ${error}`);
      return {};
    });

    // Start the machine and kick off the workflow
    machine.start().then(() => {
      machine.send('start').catch((err: unknown) => {
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });
    });
  });
}
