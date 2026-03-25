/**
 * Tests for guard expression parsing and evaluation.
 */

import { parseOrca } from "../src/parser.js";
import { OrcaMachine } from "../src/machine.js";
import { getEventBus, resetEventBus } from "../src/bus.js";

// Helper to create a minimal Orca machine definition string
function orcaSrc(guardDef: string, contextLine = ""): string {
  return `machine test

${contextLine ? `context {\n  ${contextLine}\n}\n` : ""}
events {
  GO
}

state idle [initial] {
}

state done [final] {
}

guards {
  g: ${guardDef}
}

transitions {
  idle + GO [g] -> done
}
`;
}

// ---- Parser tests ----

function testParseTrue() {
  const def = parseOrca(orcaSrc("true"));
  const guard = def.guards["g"];
  assert(guard !== undefined, "Guard 'g' not found");
  assert(guard.kind === "true", `Expected kind 'true', got '${guard.kind}'`);
}

function testParseFalse() {
  const def = parseOrca(orcaSrc("false"));
  const guard = def.guards["g"];
  assert(guard !== undefined, "Guard 'g' not found");
  assert(guard.kind === "false", `Expected kind 'false', got '${guard.kind}'`);
}

function testParseCompare() {
  const def = parseOrca(orcaSrc("ctx.retry_count < 3", "retry_count: number = 0"));
  const guard = def.guards["g"];
  assert(guard !== undefined, "Guard 'g' not found");
  assert(guard.kind === "compare", `Expected kind 'compare', got '${guard.kind}'`);
  if (guard.kind === "compare") {
    assert(guard.op === "lt", `Expected op 'lt', got '${guard.op}'`);
    assert(guard.left.path.join(".") === "ctx.retry_count", `Expected path 'ctx.retry_count', got '${guard.left.path.join(".")}'`);
    assert(guard.right.value === 3, `Expected value 3, got '${guard.right.value}'`);
  }
}

function testParseNullcheck() {
  const def = parseOrca(orcaSrc("ctx.token != null", "token: string"));
  const guard = def.guards["g"];
  assert(guard !== undefined, "Guard 'g' not found");
  assert(guard.kind === "nullcheck", `Expected kind 'nullcheck', got '${guard.kind}'`);
  if (guard.kind === "nullcheck") {
    assert(guard.isNull === false, `Expected isNull false`);
    assert(guard.expr.path.join(".") === "ctx.token", `Expected path 'ctx.token'`);
  }
}

function testParseNullcheckEqual() {
  const def = parseOrca(orcaSrc("ctx.value == null"));
  const guard = def.guards["g"];
  assert(guard !== undefined, "Guard 'g' not found");
  assert(guard.kind === "nullcheck", `Expected kind 'nullcheck', got '${guard.kind}'`);
  if (guard.kind === "nullcheck") {
    assert(guard.isNull === true, `Expected isNull true`);
  }
}

function testParseAnd() {
  const def = parseOrca(orcaSrc("ctx.a > 1 and ctx.b < 10"));
  const guard = def.guards["g"];
  assert(guard !== undefined, "Guard 'g' not found");
  assert(guard.kind === "and", `Expected kind 'and', got '${guard.kind}'`);
  if (guard.kind === "and") {
    assert(guard.left.kind === "compare", `Expected left kind 'compare'`);
    assert(guard.right.kind === "compare", `Expected right kind 'compare'`);
  }
}

function testParseOr() {
  const def = parseOrca(orcaSrc("ctx.a == 1 or ctx.b == 2"));
  const guard = def.guards["g"];
  assert(guard !== undefined, "Guard 'g' not found");
  assert(guard.kind === "or", `Expected kind 'or', got '${guard.kind}'`);
}

function testParseNot() {
  const def = parseOrca(orcaSrc("not ctx.allowed"));
  const guard = def.guards["g"];
  assert(guard !== undefined, "Guard 'g' not found");
  assert(guard.kind === "not", `Expected kind 'not', got '${guard.kind}'`);
}

function testParseCompareGe() {
  const def = parseOrca(orcaSrc("ctx.score >= 100"));
  const guard = def.guards["g"];
  assert(guard !== undefined, "Guard 'g' not found");
  assert(guard.kind === "compare", `Expected kind 'compare', got '${guard.kind}'`);
  if (guard.kind === "compare") {
    assert(guard.op === "ge", `Expected op 'ge', got '${guard.op}'`);
  }
}

function testParseStringCompare() {
  const def = parseOrca(orcaSrc('ctx.status == "pending"'));
  const guard = def.guards["g"];
  assert(guard !== undefined, "Guard 'g' not found");
  assert(guard.kind === "compare", `Expected kind 'compare', got '${guard.kind}'`);
  if (guard.kind === "compare") {
    assert(guard.op === "eq", `Expected op 'eq', got '${guard.op}'`);
    assert(guard.right.value === "pending", `Expected value 'pending', got '${guard.right.value}'`);
  }
}

// ---- Evaluator tests ----

async function testEvalComparePass() {
  resetEventBus();
  const def = parseOrca(orcaSrc("ctx.retry_count < 3", "retry_count: number = 0"));
  const machine = new OrcaMachine(def, getEventBus(), { retry_count: 1 });
  await machine.start();
  const result = await machine.send("GO");
  assert(result.taken === true, `Expected transition taken, got: ${result.error}`);
  assert(result.toState === "done", `Expected state 'done', got '${result.toState}'`);
}

async function testEvalCompareFail() {
  resetEventBus();
  const def = parseOrca(orcaSrc("ctx.retry_count < 3", "retry_count: number = 0"));
  const machine = new OrcaMachine(def, getEventBus(), { retry_count: 5 });
  await machine.start();
  const result = await machine.send("GO");
  assert(result.taken === false, `Expected transition NOT taken`);
  assert(result.guardFailed === true, `Expected guardFailed`);
}

async function testEvalNullcheckPass() {
  resetEventBus();
  const def = parseOrca(orcaSrc("ctx.token != null", "token: string"));
  const machine = new OrcaMachine(def, getEventBus(), { token: "abc123" });
  await machine.start();
  const result = await machine.send("GO");
  assert(result.taken === true, `Expected transition taken, got: ${result.error}`);
}

async function testEvalNullcheckFail() {
  resetEventBus();
  const def = parseOrca(orcaSrc("ctx.token != null", "token: string"));
  const machine = new OrcaMachine(def, getEventBus(), { token: null });
  await machine.start();
  const result = await machine.send("GO");
  assert(result.taken === false, `Expected transition NOT taken`);
  assert(result.guardFailed === true, `Expected guardFailed`);
}

async function testEvalAndBothTrue() {
  resetEventBus();
  const def = parseOrca(orcaSrc("ctx.a > 1 and ctx.b < 10"));
  const machine = new OrcaMachine(def, getEventBus(), { a: 5, b: 3 });
  await machine.start();
  const result = await machine.send("GO");
  assert(result.taken === true, `Expected transition taken, got: ${result.error}`);
}

async function testEvalAndOneFalse() {
  resetEventBus();
  const def = parseOrca(orcaSrc("ctx.a > 1 and ctx.b < 10"));
  const machine = new OrcaMachine(def, getEventBus(), { a: 0, b: 3 });
  await machine.start();
  const result = await machine.send("GO");
  assert(result.taken === false, `Expected transition NOT taken`);
}

async function testEvalOrOneTrue() {
  resetEventBus();
  const def = parseOrca(orcaSrc("ctx.a == 1 or ctx.b == 2"));
  const machine = new OrcaMachine(def, getEventBus(), { a: 99, b: 2 });
  await machine.start();
  const result = await machine.send("GO");
  assert(result.taken === true, `Expected transition taken, got: ${result.error}`);
}

async function testEvalOrBothFalse() {
  resetEventBus();
  const def = parseOrca(orcaSrc("ctx.a == 1 or ctx.b == 2"));
  const machine = new OrcaMachine(def, getEventBus(), { a: 99, b: 99 });
  await machine.start();
  const result = await machine.send("GO");
  assert(result.taken === false, `Expected transition NOT taken`);
}

async function testEvalNotNullIsTrue() {
  resetEventBus();
  // "not ctx.blocked" => not(nullcheck(blocked, isNull=false))
  // When blocked is null: nullcheck returns false (value IS null), not(false) = true
  const def = parseOrca(orcaSrc("not ctx.blocked"));
  const machine = new OrcaMachine(def, getEventBus(), { blocked: null });
  await machine.start();
  const result = await machine.send("GO");
  assert(result.taken === true, `Expected transition taken, got: ${result.error}`);
}

async function testEvalNotPresentIsFalse() {
  resetEventBus();
  // When blocked is a non-null value: nullcheck(isNull=false) => true, not(true) = false
  const def = parseOrca(orcaSrc("not ctx.blocked"));
  const machine = new OrcaMachine(def, getEventBus(), { blocked: "yes" });
  await machine.start();
  const result = await machine.send("GO");
  assert(result.taken === false, `Expected transition NOT taken`);
}

async function testEvalStringComparePass() {
  resetEventBus();
  const def = parseOrca(orcaSrc('ctx.status == "pending"'));
  const machine = new OrcaMachine(def, getEventBus(), { status: "pending" });
  await machine.start();
  const result = await machine.send("GO");
  assert(result.taken === true, `Expected transition taken, got: ${result.error}`);
}

async function testEvalStringCompareFail() {
  resetEventBus();
  const def = parseOrca(orcaSrc('ctx.status == "pending"'));
  const machine = new OrcaMachine(def, getEventBus(), { status: "active" });
  await machine.start();
  const result = await machine.send("GO");
  assert(result.taken === false, `Expected transition NOT taken`);
}

async function testEvalCompareGe() {
  resetEventBus();
  const def = parseOrca(orcaSrc("ctx.score >= 100"));
  const machine = new OrcaMachine(def, getEventBus(), { score: 100 });
  await machine.start();
  const result = await machine.send("GO");
  assert(result.taken === true, `Expected transition taken, got: ${result.error}`);
}

async function testEvalTrueLiteral() {
  resetEventBus();
  const def = parseOrca(orcaSrc("true"));
  const machine = new OrcaMachine(def, getEventBus());
  await machine.start();
  const result = await machine.send("GO");
  assert(result.taken === true, `Expected transition taken, got: ${result.error}`);
}

async function testEvalFalseLiteral() {
  resetEventBus();
  const def = parseOrca(orcaSrc("false"));
  const machine = new OrcaMachine(def, getEventBus());
  await machine.start();
  const result = await machine.send("GO");
  assert(result.taken === false, `Expected transition NOT taken`);
  assert(result.guardFailed === true, `Expected guardFailed`);
}

// ---- Test runner ----

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

const tests: [string, () => void | Promise<void>][] = [
  // Parser tests
  ["parse true literal", testParseTrue],
  ["parse false literal", testParseFalse],
  ["parse compare expression", testParseCompare],
  ["parse nullcheck (!=)", testParseNullcheck],
  ["parse nullcheck (==)", testParseNullcheckEqual],
  ["parse and expression", testParseAnd],
  ["parse or expression", testParseOr],
  ["parse not expression", testParseNot],
  ["parse compare >=", testParseCompareGe],
  ["parse string compare", testParseStringCompare],
  // Evaluator tests
  ["eval compare pass (1 < 3)", testEvalComparePass],
  ["eval compare fail (5 < 3)", testEvalCompareFail],
  ["eval nullcheck pass (token present)", testEvalNullcheckPass],
  ["eval nullcheck fail (token null)", testEvalNullcheckFail],
  ["eval and (both true)", testEvalAndBothTrue],
  ["eval and (one false)", testEvalAndOneFalse],
  ["eval or (one true)", testEvalOrOneTrue],
  ["eval or (both false)", testEvalOrBothFalse],
  ["eval not (null value = true)", testEvalNotNullIsTrue],
  ["eval not (present value = false)", testEvalNotPresentIsFalse],
  ["eval string compare pass", testEvalStringComparePass],
  ["eval string compare fail", testEvalStringCompareFail],
  ["eval compare >= boundary", testEvalCompareGe],
  ["eval true literal", testEvalTrueLiteral],
  ["eval false literal", testEvalFalseLiteral],
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
