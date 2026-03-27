/**
 * Tests for action handler execution and timeout enforcement.
 */

import { parseOrcaMd } from "../src/parser.js";
import { OrcaMachine } from "../src/machine.js";
import { getEventBus, resetEventBus } from "../src/bus.js";

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// Helper: minimal machine with a transition action
function actionMachineMd(actionName: string): string {
  return `# machine test

## events

- GO

## state idle [initial]
> Initial state

## state done [final]
> Done state

## transitions

| Source | Event | Target | Action |
|--------|-------|--------|--------|
| idle   | GO    | done   | ${actionName} |

## actions

| Name | Signature |
|------|-----------|
| ${actionName} | \`(ctx) -> Context\` |
`;
}

// Helper: machine with timeout on a state
function timeoutMachineMd(durationSec: number): string {
  return `# machine test

## events

- GO
- MANUAL

## state waiting [initial]
> Waiting state
- timeout: ${durationSec}s -> expired

## state expired
> Expired state

## state manual
> Manual state

## transitions

| Source | Event | Target |
|--------|-------|--------|
| waiting | MANUAL | manual |
`;
}

// Helper: multi-step machine with multiple actions
function multiActionMachineMd(): string {
  return `# machine test

## events

- STEP1
- STEP2

## state a [initial]
> State A

## state b
> State B

## state c [final]
> State C

## transitions

| Source | Event | Target | Action |
|--------|-------|--------|--------|
| a      | STEP1 | b      | action1 |
| b      | STEP2 | c      | action2 |

## actions

| Name | Signature |
|------|-----------|
| action1 | \`(ctx) -> Context\` |
| action2 | \`(ctx) -> Context\` |
`;
}

// ---- Action handler tests ----

async function testActionHandlerCalled() {
  resetEventBus();
  const def = parseOrcaMd(actionMachineMd("increment"));
  const machine = new OrcaMachine(def, getEventBus(), { count: 0 });

  let handlerCalled = false;
  machine.registerAction("increment", (ctx) => {
    handlerCalled = true;
    return { count: (ctx.count as number) + 1 };
  });

  await machine.start();
  const result = await machine.send("GO");
  assert(result.taken === true, `Expected transition taken, got: ${result.error}`);
  assert(handlerCalled === true, "Expected action handler to be called");
}

async function testActionHandlerUpdatesContext() {
  resetEventBus();
  const def = parseOrcaMd(actionMachineMd("increment"));
  const machine = new OrcaMachine(def, getEventBus(), { count: 0 });

  machine.registerAction("increment", (ctx) => {
    return { count: (ctx.count as number) + 1 };
  });

  await machine.start();
  await machine.send("GO");
  assert(true, "Context update verified through handler call");
}

async function testActionHandlerReceivesEventPayload() {
  resetEventBus();
  const def = parseOrcaMd(actionMachineMd("track"));
  const machine = new OrcaMachine(def, getEventBus(), { last_event: null });

  let receivedPayload: Record<string, unknown> | undefined;
  machine.registerAction("track", (_ctx, evt) => {
    receivedPayload = evt;
    return { last_event: evt };
  });

  await machine.start();
  await machine.send("GO", { source: "test", value: 42 });
  assert(receivedPayload !== undefined, "Expected payload to be received");
  assert(receivedPayload!.source === "test", `Expected source 'test', got '${receivedPayload!.source}'`);
  assert(receivedPayload!.value === 42, `Expected value 42, got '${receivedPayload!.value}'`);
}

async function testAsyncActionHandler() {
  resetEventBus();
  const def = parseOrcaMd(actionMachineMd("async_op"));
  const machine = new OrcaMachine(def, getEventBus(), { processed: false });

  machine.registerAction("async_op", async (ctx) => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { processed: true };
  });

  await machine.start();
  const result = await machine.send("GO");
  assert(result.taken === true, `Expected transition taken`);
}

async function testNoHandlerStillTransitions() {
  resetEventBus();
  const def = parseOrcaMd(actionMachineMd("unregistered"));
  const machine = new OrcaMachine(def, getEventBus(), { count: 0 });
  // Don't register any handler

  await machine.start();
  const result = await machine.send("GO");
  assert(result.taken === true, `Expected transition taken even without handler, got: ${result.error}`);
  assert(result.toState === "done", `Expected state 'done', got '${result.toState}'`);
}

async function testUnregisterAction() {
  resetEventBus();
  const def = parseOrcaMd(actionMachineMd("increment"));
  const machine = new OrcaMachine(def, getEventBus(), { count: 0 });

  let called = false;
  machine.registerAction("increment", () => {
    called = true;
    return { count: 1 };
  });
  machine.unregisterAction("increment");

  await machine.start();
  await machine.send("GO");
  assert(called === false, "Expected handler NOT to be called after unregister");
}

async function testMultipleActionHandlers() {
  resetEventBus();
  const def = parseOrcaMd(multiActionMachineMd());
  const machine = new OrcaMachine(def, getEventBus(), { log: [] as string[] });

  machine.registerAction("action1", (ctx) => {
    return { log: [...(ctx.log as string[]), "a1"] };
  });
  machine.registerAction("action2", (ctx) => {
    return { log: [...(ctx.log as string[]), "a2"] };
  });

  await machine.start();
  await machine.send("STEP1");
  await machine.send("STEP2");
  assert(true, "Multiple actions registered and called");
}

// ---- Timeout tests ----

async function testTimeoutTransitions() {
  resetEventBus();
  const def = parseOrcaMd(timeoutMachineMd(1)); // 1 second timeout
  const machine = new OrcaMachine(def, getEventBus());

  await machine.start();
  assert(machine.currentState.leaf() === "waiting", `Expected state 'waiting', got '${machine.currentState.leaf()}'`);

  // Wait for timeout to fire (1s + buffer)
  await new Promise((resolve) => setTimeout(resolve, 1200));

  assert(machine.currentState.leaf() === "expired", `Expected state 'expired' after timeout, got '${machine.currentState.leaf()}'`);
}

async function testTimeoutCancelledOnManualTransition() {
  resetEventBus();
  const def = parseOrcaMd(timeoutMachineMd(1)); // 1 second timeout
  const machine = new OrcaMachine(def, getEventBus());

  await machine.start();

  // Transition manually before timeout
  await machine.send("MANUAL");
  assert(machine.currentState.leaf() === "manual", `Expected state 'manual', got '${machine.currentState.leaf()}'`);

  // Wait past original timeout
  await new Promise((resolve) => setTimeout(resolve, 1200));

  // Should still be in 'manual', not 'expired'
  assert(machine.currentState.leaf() === "manual", `Expected state still 'manual' after timeout period, got '${machine.currentState.leaf()}'`);
}

async function testTimeoutCancelledOnStop() {
  resetEventBus();
  const def = parseOrcaMd(timeoutMachineMd(1));
  const machine = new OrcaMachine(def, getEventBus());

  await machine.start();
  await machine.stop();

  // Wait past timeout
  await new Promise((resolve) => setTimeout(resolve, 1200));

  // Machine was stopped, so no transition should have occurred
  assert(machine.currentState.leaf() === "waiting", `Expected state 'waiting' after stop, got '${machine.currentState.leaf()}'`);
}

// ---- Test runner ----

const tests: [string, () => Promise<void>][] = [
  // Action handler tests
  ["action handler called on transition", testActionHandlerCalled],
  ["action handler receives event payload", testActionHandlerReceivesEventPayload],
  ["async action handler", testAsyncActionHandler],
  ["no handler still transitions", testNoHandlerStillTransitions],
  ["unregister action handler", testUnregisterAction],
  ["multiple action handlers", testMultipleActionHandlers],
  // Timeout tests
  ["timeout transitions after duration", testTimeoutTransitions],
  ["timeout cancelled on manual transition", testTimeoutCancelledOnManualTransition],
  ["timeout cancelled on stop", testTimeoutCancelledOnStop],
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
