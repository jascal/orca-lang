import { existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';

const LOCK_DIR = join(homedir(), '.orca', 'locks');
const LOCK_TIMEOUT_MS = 30000; // 30 seconds

interface Lock {
  release: () => void;
}

async function mkdirp(dir: string): Promise<void> {
  if (!existsSync(dir)) {
    mkdirSync(dir, { mode: 0o700, recursive: true });
  }
}

export async function withFileLock<T>(
  resource: string,
  fn: () => Promise<T>
): Promise<T> {
  await mkdirp(LOCK_DIR);

  // Create a unique lock file for this resource
  const resourceHash = createHash('sha256').update(resource).digest('hex').slice(0, 16);
  const lockFile = join(LOCK_DIR, `${resourceHash}.lock`);

  const startTime = Date.now();

  // Wait for lock
  while (existsSync(lockFile)) {
    if (Date.now() - startTime > LOCK_TIMEOUT_MS) {
      throw new Error(`Timeout waiting for lock on ${resource}`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  // Acquire lock
  const pid = process.pid.toString();
  const lockContent = JSON.stringify({ pid, time: Date.now() });

  // Use writeFileSync for atomic lock acquisition
  // In a production system, you'd use a proper file locking mechanism
  // This is a simplified version
  try {
    // Try to create the lock file exclusively
    const { writeFileSync } = await import('fs');
    writeFileSync(lockFile, lockContent, { flag: 'wx' });
  } catch (err: unknown) {
    const error = err as { code?: string };
    if (error.code === 'EEXIST') {
      // Lock already exists, wait and retry
      await new Promise(resolve => setTimeout(resolve, 100));
      return withFileLock(resource, fn);
    }
    throw err;
  }

  // Execute the protected operation
  try {
    return await fn();
  } finally {
    // Release lock
    try {
      unlinkSync(lockFile);
    } catch {
      // Ignore cleanup errors
    }
  }
}
