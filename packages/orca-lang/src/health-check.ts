#!/usr/bin/env node
// Health Check Runner - Dogfooding Orca to check itself
// Uses sequential execution pattern modeled after Orca state machine semantics

import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../../..');

interface StepResult {
  name: string;
  status: 'pending' | 'success' | 'failed';
  output: string;
  duration: number;
  passed?: number;
  skipped?: number;
}

interface HealthReport {
  steps: StepResult[];
  startTime: number;
  endTime: number;
  totalPassed: number;
  totalFailed: number;
}

function runCommand(cmd: string, cwd: string, timeout = 120000): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execSync(cmd, { cwd, encoding: 'utf-8', timeout, maxBuffer: 10 * 1024 * 1024 });
    return { status: 0, stdout: stdout as string, stderr: '' };
  } catch (e: any) {
    return {
      status: e.status || 1,
      stdout: e.stdout?.toString() || '',
      stderr: e.stderr?.toString() || e.message || ''
    };
  }
}

async function runHealthCheck(): Promise<HealthReport> {
  const report: HealthReport = {
    steps: [],
    startTime: Date.now(),
    endTime: 0,
    totalPassed: 0,
    totalFailed: 0
  };

  // ── Step 1: Build ──────────────────────────────────────────────
  {
    const step: StepResult = { name: 'build', status: 'pending', output: '', duration: 0 };
    const start = Date.now();
    console.log('━━━ Building TypeScript packages ━━━');
    const result = runCommand('pnpm run build', REPO_ROOT);
    step.duration = Date.now() - start;
    step.status = result.status === 0 ? 'success' : 'failed';
    step.output = result.status === 0 ? 'Build succeeded' : result.stderr || result.stdout;
    report.steps.push(step);
    console.log(`  ${step.status === 'success' ? '✓' : '✗'} Build ${step.status} (${step.duration}ms)\n`);
    if (step.status === 'failed') {
      report.endTime = Date.now();
      return report;
    }
  }

  // ── Step 2: orca-lang tests ─────────────────────────────────────
  {
    const step: StepResult = { name: 'test:lang', status: 'pending', output: '', duration: 0 };
    const start = Date.now();
    console.log('━━━ Running orca-lang tests ━━━');
    const result = runCommand('cd packages/orca-lang && pnpm test 2>&1', REPO_ROOT);
    step.duration = Date.now() - start;
    const match = result.stdout.match(/(\d+) passed.*?(\d+) skipped/);
    step.passed = match ? parseInt(match[1]) : 0;
    step.skipped = match ? parseInt(match[2]) : 0;
    step.status = result.status === 0 && step.passed >= 180 ? 'success' : 'failed';
    step.output = `${step.passed} passed, ${step.skipped} skipped`;
    report.steps.push(step);
    console.log(`  ${step.status === 'success' ? '✓' : '✗'} ${step.passed} tests passed, ${step.skipped} skipped (${step.duration}ms)\n`);
    if (step.status === 'failed') {
      report.endTime = Date.now();
      return report;
    }
  }

  // ── Step 3: demo-ts smoke test ─────────────────────────────────
  {
    const step: StepResult = { name: 'demo-ts:test', status: 'pending', output: '', duration: 0 };
    const start = Date.now();
    console.log('━━━ Running demo-ts smoke test ━━━');
    const result = runCommand('pnpm --filter orca-demo-ts run test 2>&1', REPO_ROOT);
    step.duration = Date.now() - start;
    step.status = result.status === 0 ? 'success' : 'failed';
    step.output = result.status === 0 ? 'Tests passed' : result.stdout;
    report.steps.push(step);
    console.log(`  ${step.status === 'success' ? '✓' : '✗'} demo-ts tests ${step.status} (${step.duration}ms)\n`);
    if (step.status === 'failed') {
      report.endTime = Date.now();
      return report;
    }
  }

  // ── Step 4: demo-ts ticket demo ─────────────────────────────────
  {
    const step: StepResult = { name: 'demo-ts:ticket', status: 'pending', output: '', duration: 0 };
    const start = Date.now();
    console.log('━━━ Running demo-ts ticket demo ━━━');
    const result = runCommand('pnpm -w run run:demo-ts:ticket 2>&1', REPO_ROOT);
    step.duration = Date.now() - start;
    step.status = result.status === 0 ? 'success' : 'failed';
    step.output = result.status === 0 ? 'Demo passed' : result.stdout;
    report.steps.push(step);
    console.log(`  ${step.status === 'success' ? '✓' : '✗'} Support Ticket demo ${step.status} (${step.duration}ms)\n`);
    if (step.status === 'failed') {
      report.endTime = Date.now();
      return report;
    }
  }

  // ── Step 5: demo-python ─────────────────────────────────────────
  {
    const step: StepResult = { name: 'demo-python', status: 'pending', output: '', duration: 0 };
    const start = Date.now();
    console.log('━━━ Running demo-python ━━━');
    const result = runCommand('.venv/bin/python packages/demo-python/demo.py 2>&1', REPO_ROOT);
    step.duration = Date.now() - start;
    step.status = result.status === 0 ? 'success' : 'failed';
    step.output = result.status === 0 ? 'Demo passed' : result.stdout;
    report.steps.push(step);
    console.log(`  ${step.status === 'success' ? '✓' : '✗'} demo-python ${step.status} (${step.duration}ms)\n`);
    if (step.status === 'failed') {
      report.endTime = Date.now();
      return report;
    }
  }

  // ── Step 6: demo-go ─────────────────────────────────────────────
  {
    const step: StepResult = { name: 'demo-go (trip)', status: 'pending', output: '', duration: 0 };
    const start = Date.now();
    console.log('━━━ Running demo-go (trip) ━━━');
    const result = runCommand('pnpm run test:demo-go 2>&1', REPO_ROOT);
    step.duration = Date.now() - start;
    step.status = result.status === 0 ? 'success' : 'failed';
    step.output = result.status === 0 ? 'Demo passed' : result.stdout;
    report.steps.push(step);
    console.log(`  ${step.status === 'success' ? '✓' : '✗'} demo-go (trip) ${step.status} (${step.duration}ms)\n`);
    if (step.status === 'failed') {
      report.endTime = Date.now();
      return report;
    }
  }

  // ── Step 6b: demo-go:loan ──────────────────────────────────────
  {
    const step: StepResult = { name: 'demo-go:loan', status: 'pending', output: '', duration: 0 };
    const start = Date.now();

    // Build the loan binary first (not pre-built like 'trip')
    console.log('━━━ Building demo-go:loan binary ━━━');
    const buildResult = runCommand('cd packages/demo-go && go build -o loan ./cmd/loan 2>&1', REPO_ROOT);
    if (buildResult.status !== 0) {
      step.duration = Date.now() - start;
      step.status = 'failed';
      step.output = buildResult.stderr || buildResult.stdout;
      report.steps.push(step);
      console.log(`  ✗ Build failed (${step.duration}ms): ${step.output}\n`);
      report.endTime = Date.now();
      return report;
    }
    console.log(`  ✓ Build succeeded (${Date.now() - start}ms)\n`);

    console.log('━━━ Running demo-go:loan (loan application) ━━━');
    const runStart = Date.now();
    const result = runCommand('cd packages/demo-go && ./loan 2>&1', REPO_ROOT);
    step.duration = Date.now() - runStart;
    step.status = result.status === 0 ? 'success' : 'failed';
    step.output = result.status === 0 ? 'Demo passed' : result.stdout;
    report.steps.push(step);
    console.log(`  ${step.status === 'success' ? '✓' : '✗'} demo-go:loan (loan) ${step.status} (${step.duration}ms)\n`);
    if (step.status === 'failed') {
      report.endTime = Date.now();
      return report;
    }
  }

  // ── Step 7: runtime-rust tests ──────────────────────────────────
  {
    const step: StepResult = { name: 'runtime-rust:test', status: 'pending', output: '', duration: 0 };
    const start = Date.now();
    console.log('━━━ Running runtime-rust tests ━━━');
    const result = runCommand('cd packages/runtime-rust && cargo test 2>&1', REPO_ROOT);
    step.duration = Date.now() - start;
    step.status = result.status === 0 ? 'success' : 'failed';
    step.output = result.status === 0 ? 'Tests passed' : result.stdout;
    report.steps.push(step);
    console.log(`  ${step.status === 'success' ? '✓' : '✗'} runtime-rust tests ${step.status} (${step.duration}ms)\n`);
    if (step.status === 'failed') {
      report.endTime = Date.now();
      return report;
    }
  }

  // ── Step 7b: demo-fortran ─────────────────────────────────────
  {
    const step: StepResult = { name: 'demo-fortran', status: 'pending', output: '', duration: 0 };
    const start = Date.now();

    // Check if gfortran is available
    const gfortranCheck = runCommand('which gfortran 2>/dev/null', REPO_ROOT);
    if (gfortranCheck.status !== 0) {
      step.duration = Date.now() - start;
      step.status = 'success';
      step.output = 'Skipped (gfortran not installed)';
      report.steps.push(step);
      console.log(`  ○ demo-fortran skipped (gfortran not installed) (${step.duration}ms)\n`);
    } else {
      console.log('━━━ Building and running demo-fortran ━━━');
      const result = runCommand('cd packages/demo-fortran && make run 2>&1', REPO_ROOT);
      step.duration = Date.now() - start;
      step.status = result.status === 0 ? 'success' : 'failed';
      step.output = result.status === 0 ? 'Demo passed' : result.stdout;
      report.steps.push(step);
      console.log(`  ${step.status === 'success' ? '✓' : '✗'} demo-fortran ${step.status} (${step.duration}ms)\n`);
      if (step.status === 'failed') {
        report.endTime = Date.now();
        return report;
      }
    }
  }

  // ── Step 8: demo-nanolab tests ─────────────────────────────────
  {
    const step: StepResult = { name: 'demo-nanolab:test', status: 'pending', output: '', duration: 0 };
    const start = Date.now();
    console.log('━━━ Running demo-nanolab tests ━━━');
    const result = runCommand('pnpm run test:demo-nanolab 2>&1', REPO_ROOT);
    step.duration = Date.now() - start;
    step.status = result.status === 0 ? 'success' : 'failed';
    step.output = result.status === 0 ? 'Tests passed' : result.stdout;
    report.steps.push(step);
    console.log(`  ${step.status === 'success' ? '✓' : '✗'} demo-nanolab tests ${step.status} (${step.duration}ms)\n`);
    if (step.status === 'failed') {
      report.endTime = Date.now();
      return report;
    }
  }

  // ── Step 8: Example verification ────────────────────────────────
  {
    const step: StepResult = { name: 'examples:verify', status: 'pending', output: '', duration: 0 };
    const start = Date.now();
    console.log('━━━ Verifying example files ━━━');
    const result = runCommand('cd packages/orca-lang && pnpm exec tsx src/index.ts verify examples/simple-toggle.orca.md examples/payment-processor.orca.md 2>&1', REPO_ROOT);
    step.duration = Date.now() - start;
    step.status = result.status === 0 ? 'success' : 'failed';
    step.output = result.status === 0 ? 'Examples verified' : result.stdout;
    report.steps.push(step);
    console.log(`  ${step.status === 'success' ? '✓' : '✗'} Examples verified ${step.status} (${step.duration}ms)\n`);
    if (step.status === 'failed') {
      report.endTime = Date.now();
      return report;
    }
  }

  report.endTime = Date.now();
  return report;
}

function printReport(report: HealthReport) {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║                    HEALTH CHECK REPORT                     ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  for (const step of report.steps) {
    const icon = step.status === 'success' ? '✓' : step.status === 'failed' ? '✗' : '○';
    const label = step.status === 'success' ? 'PASS' : step.status === 'failed' ? 'FAIL' : 'SKIP';
    console.log(`  ${icon} ${step.name.padEnd(20)} ${label.padEnd(6)} ${step.duration}ms${step.passed !== undefined ? ` (${step.passed} tests)` : ''}`);
  }

  const totalDuration = report.endTime - report.startTime;
  report.totalPassed = report.steps.filter(s => s.status === 'success').length;
  report.totalFailed = report.steps.filter(s => s.status === 'failed').length;

  console.log(`\n  Total time: ${totalDuration}ms`);
  console.log(`  Passed: ${report.totalPassed}/${report.totalPassed + report.totalFailed}\n`);

  if (report.totalFailed === 0) {
    console.log('  ✓ ALL CHECKS PASSED - Project is healthy\n');
  } else {
    console.log(`  ✗ ${report.totalFailed} CHECK(S) FAILED\n`);
    // Print failed step outputs
    for (const step of report.steps.filter(s => s.status === 'failed')) {
      console.log(`  ── ${step.name} output ──`);
      console.log(`  ${step.output.split('\n').slice(0, 10).join('\n  ')}`);
      if (step.output.split('\n').length > 10) console.log('  ... (truncated)');
      console.log();
    }
  }
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║           ORCA HEALTH CHECK - SELF-HOSTED RUNNER           ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  const report = await runHealthCheck();
  printReport(report);

  process.exit(report.totalFailed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Health check failed with error:', err);
  process.exit(1);
});
