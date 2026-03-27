/**
 * Tests for ignored event enforcement.
 */

import { parseOrcaMd } from "../src/parser.js";
import { OrcaMachine } from "../src/machine.js";
import { getEventBus, resetEventBus } from "../src/bus.js";

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// Machine where state idle ignores PING
function ignoredEventMachineMd(): string {
  return `# machine test

## events

- GO
- PING

## state idle [initial]
> Initial state
- ignore: PING

## state done [final]
> Done state

## transitions

| Source | Event | Target |
|--------|-------|--------|
| idle   | GO    | done   |
`;
}

// Machine with multiple ignored events
function multiIgnoreMachineMd(): string {
  return `# machine test

## events

- GO
- PING
- HEARTBEAT

## state idle [initial]
> Initial state
- ignore: PING, HEARTBEAT

## state done [final]
> Done state

## transitions

| Source | Event | Target |
|--------|-------|--------|
| idle   | GO    | done   |
`;
}

// Machine with ignored event that does not affect other states
function ignoredInOnlyOneStateMd(): string {
  return `# machine test

## events

- GO
- PING
- RESET

## state idle [initial]
> Initial state
- ignore: PING

## state active
> Active state
- ignore: RESET

## state done [final]
> Done state

## transitions

| Source | Event | Target |
|--------|-------|--------|
| idle   | GO    | active |
| active | PING  | done   |
| active | GO   | done   |
`;
}

// ---- Parser tests ----

function testParseIgnoredEvents() {
  const def = parseOrcaMd(ignoredEventMachineMd());
  const idleState = def.states.find(s => s.name === "idle");
  assert(idleState !== undefined, "idle state not found");
  assert(idleState!.ignoredEvents.length === 1, `Expected 1 ignored event, got ${idleState!.ignoredEvents.length}`);
  assert(idleState!.ignoredEvents[0] === "PING", `Expected 'PING', got '${idleState!.ignoredEvents[0]}'`);
}

function testParseMultipleIgnoredEvents() {
  const def = parseOrcaMd(multiIgnoreMachineMd());
  const idleState = def.states.find(s => s.name === "idle");
  assert(idleState !== undefined, "idle state not found");
  assert(idleState!.ignoredEvents.length === 2, `Expected 2 ignored events, got ${idleState!.ignoredEvents.length}`);
  assert(idleState!.ignoredEvents.includes("PING"), "Expected PING in ignored events");
  assert(idleState!.ignoredEvents.includes("HEARTBEAT"), "Expected HEARTBEAT in ignored events");
}

// ---- Runtime enforcement tests ----

async function testIgnoredEventReturnsSilently() {
  resetEventBus();
  const def = parseOrcaMd(ignoredEventMachineMd());
  const machine = new OrcaMachine(def, getEventBus());

  await machine.start();
  const result = await machine.send("PING");

  // Ignored event: taken=false, no error
  assert(result.taken === false, "Expected transition not taken");
  assert(result.error === undefined, `Expected no error for ignored event, got: ${result.error}`);
  assert(machine.currentState.leaf() === "idle", `Expected state 'idle', got '${machine.currentState.leaf()}'`);
}

async function testUnhandledEventReturnsError() {
  resetEventBus();
  const def = parseOrcaMd(`# machine test

## events

- GO
- UNKNOWN

## state idle [initial]
> Initial state

## state done [final]
> Done state

## transitions

| Source | Event | Target |
|--------|-------|--------|
| idle   | GO    | done   |
`);
  const machine = new OrcaMachine(def, getEventBus());

  await machine.start();
  const result = await machine.send("UNKNOWN");

  // Unhandled event: taken=false, with error
  assert(result.taken === false, "Expected transition not taken");
  assert(result.error !== undefined, "Expected error for unhandled event");
}

async function testHandledEventStillWorks() {
  resetEventBus();
  const def = parseOrcaMd(ignoredEventMachineMd());
  const machine = new OrcaMachine(def, getEventBus());

  await machine.start();
  const result = await machine.send("GO");

  assert(result.taken === true, `Expected transition taken, got: ${result.error}`);
  assert(result.toState === "done", `Expected state 'done', got '${result.toState}'`);
}

async function testMultipleIgnoredEventsEnforced() {
  resetEventBus();
  const def = parseOrcaMd(multiIgnoreMachineMd());
  const machine = new OrcaMachine(def, getEventBus());

  await machine.start();

  const r1 = await machine.send("PING");
  assert(r1.taken === false && r1.error === undefined, "PING should be silently ignored");

  const r2 = await machine.send("HEARTBEAT");
  assert(r2.taken === false && r2.error === undefined, "HEARTBEAT should be silently ignored");

  // Regular transition still works
  const r3 = await machine.send("GO");
  assert(r3.taken === true, `Expected GO transition taken, got: ${r3.error}`);
}

async function testIgnoredInOneStateNotAnother() {
  resetEventBus();
  const def = parseOrcaMd(ignoredInOnlyOneStateMd());
  const machine = new OrcaMachine(def, getEventBus());

  await machine.start();

  // PING is ignored in idle
  const r1 = await machine.send("PING");
  assert(r1.taken === false && r1.error === undefined, "PING should be silently ignored in idle");

  // RESET is NOT ignored in idle (no transition, returns error)
  const r1b = await machine.send("RESET");
  assert(r1b.taken === false && r1b.error !== undefined, "RESET should return error in idle (not ignored, not handled)");

  // Move to active
  await machine.send("GO");
  assert(machine.currentState.leaf() === "active", "Should be in active");

  // RESET is ignored in active
  const r2 = await machine.send("RESET");
  assert(r2.taken === false && r2.error === undefined, "RESET should be silently ignored in active");

  // PING is NOT ignored in active — has a transition
  const r3 = await machine.send("PING");
  assert(r3.taken === true, `Expected PING transition in active, got: ${r3.error}`);
}

async function testIgnoredEventOnlyInSpecificState() {
  resetEventBus();
  const src = `# machine test

## events

- GO
- PING
- BACK

## state idle [initial]
> Initial state
- ignore: PING

## state active
> Active state

## transitions

| Source | Event | Target |
|--------|-------|--------|
| idle   | GO    | active |
| active | PING  | idle   |
| active | BACK  | idle   |
`;
  const def = parseOrcaMd(src);
  const machine = new OrcaMachine(def, getEventBus());

  await machine.start();

  // PING is ignored in idle
  const r1 = await machine.send("PING");
  assert(r1.taken === false && r1.error === undefined, "PING should be ignored in idle");

  // Transition to active
  await machine.send("GO");
  assert(machine.currentState.leaf() === "active", "Should be in active state");

  // PING is NOT ignored in active — it has a transition
  const r2 = await machine.send("PING");
  assert(r2.taken === true, `Expected PING transition in active, got: ${r2.error}`);
}

// ---- Test runner ----

const tests: [string, () => void | Promise<void>][] = [
  // Parser tests
  ["parse single ignored event", testParseIgnoredEvents],
  ["parse multiple ignored events", testParseMultipleIgnoredEvents],
  // Runtime tests
  ["ignored event returns silently (no error)", testIgnoredEventReturnsSilently],
  ["unhandled event returns error", testUnhandledEventReturnsError],
  ["handled event still transitions", testHandledEventStillWorks],
  ["multiple ignored events enforced", testMultipleIgnoredEventsEnforced],
  ["ignored in one state does not affect another", testIgnoredInOneStateNotAnother],
  ["ignored event only in specific state", testIgnoredEventOnlyInSpecificState],
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
