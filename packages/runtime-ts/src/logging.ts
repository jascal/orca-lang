/**
 * Structured audit logging for Orca machine transitions.
 *
 * LogSink protocol with three implementations:
 *   FileSink    — JSONL append, one entry per transition
 *   ConsoleSink — human-readable [HH:MM:SS] Machine from → to (EVENT) key=val
 *   MultiSink   — fan-out to multiple sinks simultaneously
 */

import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";

export interface LogEntry {
  ts: string;
  run_id: string;
  machine: string;
  event: string;
  from: string;
  to: string;
  context_delta: Record<string, unknown>;
}

export interface LogSink {
  write(entry: LogEntry): void;
  close(): void;
}

export class FileSink implements LogSink {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  write(entry: LogEntry): void {
    appendFileSync(this.path, JSON.stringify(entry) + "\n", "utf-8");
  }

  close(): void {}
}

export class ConsoleSink implements LogSink {
  write(entry: LogEntry): void {
    const timePart = entry.ts.slice(11, 19);
    const machine = entry.machine.padEnd(14);
    const deltaStr = Object.keys(entry.context_delta).length > 0
      ? "  " + Object.entries(entry.context_delta).map(([k, v]) => `${k}=${v}`).join("  ")
      : "";
    const eventStr = entry.event ? `  (${entry.event})` : "";
    console.log(`[${timePart}] ${machine} ${entry.from} → ${entry.to}${eventStr}${deltaStr}`);
  }

  close(): void {}
}

export class MultiSink implements LogSink {
  private readonly sinks: LogSink[];

  constructor(...sinks: LogSink[]) {
    this.sinks = sinks;
  }

  write(entry: LogEntry): void {
    for (const sink of this.sinks) sink.write(entry);
  }

  close(): void {
    for (const sink of this.sinks) sink.close();
  }
}

export function makeEntry(options: {
  runId: string;
  machine: string;
  event: string;
  from: string;
  to: string;
  contextDelta: Record<string, unknown>;
}): LogEntry {
  return {
    ts: new Date().toISOString(),
    run_id: options.runId,
    machine: options.machine,
    event: options.event,
    from: options.from,
    to: options.to,
    context_delta: options.contextDelta,
  };
}
