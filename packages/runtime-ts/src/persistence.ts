/**
 * Pluggable persistence for Orca machine snapshots.
 *
 * PersistenceAdapter is a protocol for saving/loading machine snapshots.
 * FilePersistence stores snapshots as JSON files with atomic write-then-rename.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { join } from "path";

export interface PersistenceAdapter {
  save(runId: string, snapshot: Record<string, unknown>): void;
  load(runId: string): Record<string, unknown> | null;
  exists(runId: string): boolean;
}

export class FilePersistence implements PersistenceAdapter {
  constructor(private readonly baseDir: string) {}

  private pathFor(runId: string): string {
    return join(this.baseDir, `${runId}.json`);
  }

  save(runId: string, snapshot: Record<string, unknown>): void {
    const path = this.pathFor(runId);
    mkdirSync(this.baseDir, { recursive: true });
    const tmp = path + ".tmp";
    writeFileSync(tmp, JSON.stringify(snapshot), "utf-8");
    renameSync(tmp, path);
  }

  load(runId: string): Record<string, unknown> | null {
    const path = this.pathFor(runId);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  }

  exists(runId: string): boolean {
    return existsSync(this.pathFor(runId));
  }
}
