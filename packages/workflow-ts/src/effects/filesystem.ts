/**
 * Filesystem effect — reads source files and applies LLM-generated changes.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
} from 'fs';
import { join, dirname } from 'path';
import type { FileChange } from '../types.js';

/**
 * Read a list of files relative to repoRoot.
 * Files that don't exist are skipped with a note.
 */
export function readContextFiles(
  paths: string[],
  repoRoot: string
): Array<{ path: string; content: string }> {
  const results: Array<{ path: string; content: string }> = [];

  for (const relPath of paths) {
    const absPath = join(repoRoot, relPath);
    if (!existsSync(absPath)) {
      results.push({ path: relPath, content: '(file not found)' });
      continue;
    }

    try {
      const content = readFileSync(absPath, 'utf-8');
      // Truncate very large files
      const truncated = content.length > 12000
        ? content.slice(0, 12000) + '\n... (truncated)'
        : content;
      results.push({ path: relPath, content: truncated });
    } catch (err) {
      results.push({ path: relPath, content: `(read error: ${String(err)})` });
    }
  }

  return results;
}

/**
 * Apply a list of file changes to disk.
 * Writes files relative to repoRoot.
 */
export function applyFileChanges(changes: FileChange[], repoRoot: string): void {
  for (const change of changes) {
    const absPath = join(repoRoot, change.path);

    if (change.operation === 'delete') {
      if (existsSync(absPath)) {
        unlinkSync(absPath);
        console.log(`  deleted: ${change.path}`);
      }
      continue;
    }

    if (!change.content) {
      throw new Error(`Change for ${change.path} has no content`);
    }

    // Ensure directory exists
    const dir = dirname(absPath);
    mkdirSync(dir, { recursive: true });

    writeFileSync(absPath, change.content, 'utf-8');
    console.log(`  ${change.operation}: ${change.path}`);
  }
}

/**
 * Read the phase document from disk.
 */
export function readPhaseDoc(filePath: string): string {
  return readFileSync(filePath, 'utf-8');
}
