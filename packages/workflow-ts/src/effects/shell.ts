/**
 * Shell effect — runs tests and git operations.
 */

import { execSync } from 'child_process';

export interface TestResult {
  passed: boolean;
  output: string;
}

/**
 * Run the project test suite at the repo root.
 * Returns test output (stdout + stderr) and whether tests passed.
 */
export function runTests(repoRoot: string): TestResult {
  try {
    const output = execSync('pnpm test', {
      cwd: repoRoot,
      encoding: 'utf-8',
      timeout: 120_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { passed: true, output };
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; message?: string };
    const output = [
      execErr.stdout ?? '',
      execErr.stderr ?? '',
      execErr.message ?? '',
    ]
      .filter(Boolean)
      .join('\n');
    return { passed: false, output };
  }
}

/**
 * Run tests for a specific package only (faster feedback loop).
 */
export function runPackageTests(repoRoot: string, packageName: string): TestResult {
  try {
    const output = execSync(`pnpm --filter ${packageName} test`, {
      cwd: repoRoot,
      encoding: 'utf-8',
      timeout: 60_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { passed: true, output };
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; message?: string };
    const output = [execErr.stdout ?? '', execErr.stderr ?? ''].filter(Boolean).join('\n');
    return { passed: false, output };
  }
}

/**
 * Stage all changed files and create a git commit.
 */
export function gitCommit(repoRoot: string, message: string, files?: string[]): void {
  if (files && files.length > 0) {
    const quoted = files.map(f => `"${f}"`).join(' ');
    execSync(`git add ${quoted}`, { cwd: repoRoot, encoding: 'utf-8' });
  } else {
    execSync('git add -A', { cwd: repoRoot, encoding: 'utf-8' });
  }

  const escapedMessage = message.replace(/"/g, '\\"');
  execSync(`git commit -m "${escapedMessage}"`, {
    cwd: repoRoot,
    encoding: 'utf-8',
  });
}

/**
 * Push the current branch to origin.
 */
export function gitPush(repoRoot: string): void {
  execSync('git push', { cwd: repoRoot, encoding: 'utf-8' });
}

/**
 * Get the current git branch name.
 */
export function gitCurrentBranch(repoRoot: string): string {
  return execSync('git rev-parse --abbrev-ref HEAD', {
    cwd: repoRoot,
    encoding: 'utf-8',
  }).trim();
}

/**
 * Check if there are any uncommitted changes in the working tree.
 */
export function gitHasChanges(repoRoot: string): boolean {
  const output = execSync('git status --porcelain', {
    cwd: repoRoot,
    encoding: 'utf-8',
  });
  return output.trim().length > 0;
}
