/**
 * Tests for snapshot() and restore() functionality.
 */

import { parseOrcaMd } from "../src/parser.js";
import { OrcaMachine } from "../src/machine.js";
import { getEventBus, resetEventBus } from "../src/bus.js";

const simpleMachineMd = `# machine test

## context

| Field | Type   | Default |
|-------|--------|---------|
| count | number | 0       |

## events

- GO
- NEXT

## state idle [initial]
> Idle state

## state processing
> Processing state

## state done [final]
> Done state

## transitions

| Source      | Event | Target     |
|-------------|-------|------------|
| idle        | GO    | processing |
| processing  | NEXT  | done       |
`;

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function testSnapshotCapturesState() {
  resetEventBus();
  const def = parseOrcaMd(simpleMachineMd);
  const machine = new OrcaMachine(def, getEventBus());
  await machine.start();

  const snap = machine.snapshot();
  assert(snap.state === "idle", `Expected state 'idle', got '${snap.state}'`);
  assert(typeof snap.timestamp === "number", "Expected numeric timestamp");
  assert(snap.context !== undefined, "Expected context in snapshot");
}

async function testSnapshotAfterTransition() {
  resetEventBus();
  const def = parseOrcaMd(simpleMachineMd);
  const machine = new OrcaMachine(def, getEventBus());
  await machine.start();

  await machine.send("GO");
  const snap = machine.snapshot();
  assert(snap.state === "processing", `Expected state 'processing', got '${snap.state}'`);
}

async function testSnapshotCapturesContext() {
  resetEventBus();
  const def = parseOrcaMd(simpleMachineMd);
  const machine = new OrcaMachine(def, getEventBus(), { count: 42 });
  await machine.start();

  const snap = machine.snapshot();
  assert((snap.context as any).count === 42, `Expected count 42, got ${(snap.context as any).count}`);
}

async function testSnapshotIsDeepCopy() {
  resetEventBus();
  const def = parseOrcaMd(simpleMachineMd);
  const ctx = { count: 5 };
  const machine = new OrcaMachine(def, getEventBus(), ctx);
  await machine.start();

  const snap = machine.snapshot();
  // Mutating original context shouldn't affect snapshot
  ctx.count = 999;
  assert((snap.context as any).count === 5, "Snapshot should be a deep copy of context");
}

async function testRestoreState() {
  resetEventBus();
  const def = parseOrcaMd(simpleMachineMd);
  const machine = new OrcaMachine(def, getEventBus());
  await machine.start();

  // Advance to processing
  await machine.send("GO");
  assert(machine.currentState.leaf() === "processing", "Should be in processing");

  // Take snapshot
  const snap = machine.snapshot();

  // Advance to done
  await machine.send("NEXT");
  assert(machine.currentState.leaf() === "done", "Should be in done");

  // Restore to processing
  await machine.restore(snap);
  assert(machine.currentState.leaf() === "processing", `Expected 'processing' after restore, got '${machine.currentState.leaf()}'`);
}

async function testRestoreContext() {
  resetEventBus();
  const def = parseOrcaMd(simpleMachineMd);
  const machine = new OrcaMachine(def, getEventBus(), { count: 10 });
  await machine.start();

  // Snapshot with count=10
  const snap = machine.snapshot();

  // Register an action that modifies context
  machine.registerAction("increment", (ctx) => ({ count: (ctx.count as number) + 1 }));

  // Restore — context should be back to count=10
  await machine.restore({ state: "processing", context: { count: 99 } });
  const snap2 = machine.snapshot();
  assert((snap2.context as any).count === 99, `Expected count 99, got ${(snap2.context as any).count}`);
}

async function testRestoreIsDeepCopy() {
  resetEventBus();
  const def = parseOrcaMd(simpleMachineMd);
  const machine = new OrcaMachine(def, getEventBus());
  await machine.start();

  const snapData = { state: "processing" as string | Record<string, unknown>, context: { count: 7 } };
  await machine.restore(snapData);

  // Mutating the restore input should NOT affect the machine
  snapData.context.count = 999;
  const current = machine.snapshot();
  assert((current.context as any).count === 7, "Restore should deep-copy context");
}

async function testRestorePreservesActiveState() {
  resetEventBus();
  const def = parseOrcaMd(simpleMachineMd);
  const machine = new OrcaMachine(def, getEventBus());
  await machine.start();

  await machine.restore({ state: "processing", context: { count: 0 } });

  // Machine should still be active and accept events
  assert(machine.isActive, "Machine should remain active after restore");
  const result = await machine.send("NEXT");
  assert(result.taken === true, `Expected transition taken after restore, got: ${result.error}`);
  assert(machine.currentState.leaf() === "done", "Should transition to done after restore");
}

async function testRoundTrip() {
  resetEventBus();
  const def = parseOrcaMd(simpleMachineMd);
  const machine = new OrcaMachine(def, getEventBus(), { count: 42 });
  await machine.start();

  await machine.send("GO");
  const snap = machine.snapshot();

  // Create a new machine and restore
  resetEventBus();
  const machine2 = new OrcaMachine(def, getEventBus());
  await machine2.start();
  await machine2.restore(snap);

  assert(machine2.currentState.leaf() === "processing", "Restored machine should be in processing");
  assert((machine2.snapshot().context as any).count === 42, "Restored machine should have correct context");

  // Continue from restored state
  const result = await machine2.send("NEXT");
  assert(result.taken === true, "Restored machine should accept next transition");
}

// ---- Test runner ----

const tests: [string, () => Promise<void>][] = [
  ["snapshot captures current state", testSnapshotCapturesState],
  ["snapshot after transition", testSnapshotAfterTransition],
  ["snapshot captures context", testSnapshotCapturesContext],
  ["snapshot is a deep copy", testSnapshotIsDeepCopy],
  ["restore restores state", testRestoreState],
  ["restore restores context", testRestoreContext],
  ["restore is a deep copy", testRestoreIsDeepCopy],
  ["restore preserves active state", testRestorePreservesActiveState],
  ["round trip snapshot/restore", testRoundTrip],
];

async function runTests() {
  let passed = 0;
  let failed = 0;

  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  PASS  ${name}`);
      passed++;
    } catch (e) {
      console.log(`  FAIL  ${name}: ${(e as Error).message}`);
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
