// Debug script to inspect compiled machine
import { tokenize, parse, compileToXStateMachine } from './runtime/orca-shim';
import { readFileSync } from 'fs';

const source = readFileSync('./src/orca/game.orca.md', 'utf-8');
const result = parse(tokenize(source));
const compiled = compileToXStateMachine(result.machine as any);

console.log('=== Effectful Actions ===');
console.log(JSON.stringify(compiled.effectMeta.effectfulActions, null, 2));

console.log('\n=== States with effectful entry ===');
for (const [name, state] of Object.entries(compiled.config.states as any)) {
  if (state.entry?.invoke) {
    console.log(`State ${name} has invoke entry:`);
    console.log(JSON.stringify(state.entry, null, 2));
  }
}

console.log('\n=== idle.on.look (transition with effectful action) ===');
const idle = compiled.config.states.idle as any;
console.log(JSON.stringify(idle.on?.look, null, 2));

console.log('\n=== generating_narrative state ===');
const genNarr = compiled.config.states.generating_narrative as any;
console.log(JSON.stringify(genNarr, null, 2));
