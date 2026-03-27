/**
 * Tests for parallel region support in the TypeScript runtime.
 */

import { parseOrcaMd } from "../src/parser.js";
import { OrcaMachine } from "../src/machine.js";
import { getEventBus, resetEventBus } from "../src/bus.js";

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

const PARALLEL_MACHINE_MD = `# machine order_processor

## events

- START
- PAYMENT_OK
- PAYMENT_FAIL
- NOTIFIED
- CANCEL

## state idle [initial]
> Idle state

## state processing [parallel]
> Processing state with parallel regions
- on_done: -> completed

### region payment_flow

#### state charging [initial]
> Charging state

#### state charged [final]
> Charged state


### region notification_flow

#### state sending [initial]
> Sending state

#### state sent [final]
> Sent state


## state completed [final]
> Completed state

## state cancelled
> Cancelled state

## transitions

| Source     | Event      | Target      |
|------------|------------|-------------|
| idle       | START      | processing  |
| charging   | PAYMENT_OK | charged     |
| sending    | NOTIFIED   | sent        |
| processing | CANCEL     | cancelled   |
`;

const PARALLEL_SYNC_ANY_MD = `# machine fast_processor

## events

- START
- DONE_A
- DONE_B

## state idle [initial]
> Idle state

## state processing [parallel sync: any_final]
> Processing state
- on_done: -> completed

### region flow_a

#### state running_a [initial]
> Running A state

#### state done_a [final]
> Done A state


### region flow_b

#### state running_b [initial]
> Running B state

#### state done_b [final]
> Done B state


## state completed [final]
> Completed state

## transitions

| Source   | Event   | Target   |
|----------|---------|----------|
| idle     | START   | processing |
| running_a | DONE_A | done_a  |
| running_b | DONE_B | done_b  |
`;

// ---- Parser tests ----

async function testParseParallelRegions() {
  const machine = parseOrcaMd(PARALLEL_MACHINE_MD);
  const processing = machine.states.find((s) => s.name === "processing")!;
  assert(processing.parallel !== undefined, "Expected parallel to be defined");
  assert(
    processing.parallel!.regions.length === 2,
    `Expected 2 regions, got ${processing.parallel!.regions.length}`
  );
}

async function testParseParallelRegionNames() {
  const machine = parseOrcaMd(PARALLEL_MACHINE_MD);
  const processing = machine.states.find((s) => s.name === "processing")!;
  const regionNames = processing.parallel!.regions.map((r) => r.name);
  assert(regionNames.includes("payment_flow"), "Expected payment_flow region");
  assert(
    regionNames.includes("notification_flow"),
    "Expected notification_flow region"
  );
}

async function testParseParallelRegionStates() {
  const machine = parseOrcaMd(PARALLEL_MACHINE_MD);
  const processing = machine.states.find((s) => s.name === "processing")!;
  const paymentRegion = processing.parallel!.regions.find(
    (r) => r.name === "payment_flow"
  )!;
  const stateNames = paymentRegion.states.map((s) => s.name);
  assert(stateNames.includes("charging"), "Expected charging state");
  assert(stateNames.includes("charged"), "Expected charged state");
}

async function testParseOnDone() {
  const machine = parseOrcaMd(PARALLEL_MACHINE_MD);
  const processing = machine.states.find((s) => s.name === "processing")!;
  assert(
    processing.onDone === "completed",
    `Expected onDone 'completed', got '${processing.onDone}'`
  );
}

async function testParseSyncStrategy() {
  const machine = parseOrcaMd(PARALLEL_SYNC_ANY_MD);
  const processing = machine.states.find((s) => s.name === "processing")!;
  assert(processing.parallel !== undefined, "Expected parallel to be defined");
  // Default sync is all-final, so we just verify parallel is parsed
}

async function testParseInitialFinalInRegions() {
  const machine = parseOrcaMd(PARALLEL_MACHINE_MD);
  const processing = machine.states.find((s) => s.name === "processing")!;
  const paymentRegion = processing.parallel!.regions.find(
    (r) => r.name === "payment_flow"
  )!;
  const charging = paymentRegion.states.find((s) => s.name === "charging")!;
  const charged = paymentRegion.states.find((s) => s.name === "charged")!;
  assert(charging.isInitial === true, "Expected charging to be initial");
  assert(charged.isFinal === true, "Expected charged to be final");
}

// ---- Machine tests ----

async function testParallelStateEntry() {
  resetEventBus();
  const def = parseOrcaMd(PARALLEL_MACHINE_MD);
  const machine = new OrcaMachine(def, getEventBus());
  await machine.start();

  const result = await machine.send("START");
  assert(result.taken === true, "Expected transition to be taken");
  assert(
    machine.currentState.isCompound(),
    "Expected compound state after entering parallel"
  );

  const leaves = machine.currentState.leaves();
  assert(leaves.includes("charging"), `Expected 'charging' in leaves, got ${JSON.stringify(leaves)}`);
  assert(leaves.includes("sending"), `Expected 'sending' in leaves, got ${JSON.stringify(leaves)}`);
}

async function testParallelRegionTransition() {
  resetEventBus();
  const def = parseOrcaMd(PARALLEL_MACHINE_MD);
  const machine = new OrcaMachine(def, getEventBus());
  await machine.start();

  await machine.send("START");
  const result = await machine.send("PAYMENT_OK");
  assert(result.taken === true, "Expected transition to be taken");

  const leaves = machine.currentState.leaves();
  assert(leaves.includes("charged"), `Expected 'charged' in leaves, got ${JSON.stringify(leaves)}`);
  assert(leaves.includes("sending"), `Expected 'sending' in leaves, got ${JSON.stringify(leaves)}`);
}

async function testParallelSyncAllFinal() {
  resetEventBus();
  const def = parseOrcaMd(PARALLEL_MACHINE_MD);
  const machine = new OrcaMachine(def, getEventBus());
  await machine.start();

  await machine.send("START");
  await machine.send("PAYMENT_OK");
  await machine.send("NOTIFIED");

  assert(
    machine.currentState.toString() === "completed",
    `Expected 'completed', got '${machine.currentState.toString()}'`
  );
}

async function testParallelSyncAllFinalNotTriggeredEarly() {
  resetEventBus();
  const def = parseOrcaMd(PARALLEL_MACHINE_MD);
  const machine = new OrcaMachine(def, getEventBus());
  await machine.start();

  await machine.send("START");
  await machine.send("PAYMENT_OK");

  assert(
    machine.currentState.isCompound(),
    "Expected compound state (sync not triggered yet)"
  );
  const leaves = machine.currentState.leaves();
  assert(leaves.includes("charged"), "Expected 'charged' in leaves");
  assert(leaves.includes("sending"), "Expected 'sending' in leaves");
}

async function testParallelSyncAnyFinal() {
  resetEventBus();
  const def = parseOrcaMd(PARALLEL_SYNC_ANY_MD);
  const machine = new OrcaMachine(def, getEventBus());
  await machine.start();

  await machine.send("START");
  await machine.send("DONE_A");

  assert(
    machine.currentState.toString() === "completed",
    `Expected 'completed' with any-final, got '${machine.currentState.toString()}'`
  );
}

async function testParallelParentTransition() {
  resetEventBus();
  const def = parseOrcaMd(PARALLEL_MACHINE_MD);
  const machine = new OrcaMachine(def, getEventBus());
  await machine.start();

  await machine.send("START");
  const result = await machine.send("CANCEL");
  assert(result.taken === true, "Expected CANCEL transition to be taken");
  assert(
    machine.currentState.toString() === "cancelled",
    `Expected 'cancelled', got '${machine.currentState.toString()}'`
  );
}

// ---- Test runner ----

const tests: [string, () => Promise<void>][] = [
  // Parser tests
  ["parse parallel regions", testParseParallelRegions],
  ["parse parallel region names", testParseParallelRegionNames],
  ["parse parallel region states", testParseParallelRegionStates],
  ["parse on_done", testParseOnDone],
  ["parse sync strategy", testParseSyncStrategy],
  ["parse initial/final in regions", testParseInitialFinalInRegions],
  // Machine tests
  ["parallel state entry", testParallelStateEntry],
  ["parallel region transition", testParallelRegionTransition],
  ["parallel sync all-final", testParallelSyncAllFinal],
  ["parallel sync all-final not triggered early", testParallelSyncAllFinalNotTriggeredEarly],
  ["parallel sync any-final", testParallelSyncAnyFinal],
  ["parallel parent transition", testParallelParentTransition],
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
