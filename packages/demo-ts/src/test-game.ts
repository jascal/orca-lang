// Test script for retro-adventure-orca game machine
// Showcases: ## effects parsing, ConsoleSink/FileSink logging,
//            FilePersistence snapshots, and OrcaMachine.resume()

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tokenize, parse, createOrcaMachine } from './runtime/orca-shim';
import { createMockHandlers } from './runtime/handlers';
import {
  ConsoleSink,
  FileSink,
  MultiSink,
  makeEntry,
  FilePersistence,
} from '@orca-lang/orca-runtime-ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const RUN_DIR = '/tmp/orca-demo';
const RUN_ID  = 'game-demo';

async function main() {
  console.log('=== Retro-Adventure Orca Test ===\n');

  // ── Parse ─────────────────────────────────────────────────────────────────
  const orcaPath = join(__dirname, 'orca', 'game.orca.md');
  const source = readFileSync(orcaPath, 'utf-8');
  const parseResult = parse(tokenize(source));
  const { machine: def } = parseResult;

  console.log(`Machine: ${def.name}`);
  console.log(`  States:      ${def.states.length}`);
  console.log(`  Events:      ${def.events.length}`);
  console.log(`  Transitions: ${def.transitions.length}`);
  console.log(`  Actions:     ${def.actions.length}`);
  console.log(`  Effects:     ${def.effects.length}`);
  for (const e of def.effects) {
    console.log(`    ${e.name}`);
    console.log(`      in:  ${e.input}`);
    console.log(`      out: ${e.output}`);
  }

  // ── Logging: ConsoleSink + FileSink via MultiSink ─────────────────────────
  const fileSink = new FileSink(`${RUN_DIR}/audit.jsonl`);
  const sink     = new MultiSink(new ConsoleSink(), fileSink);

  // ── Persistence ───────────────────────────────────────────────────────────
  const persistence = new FilePersistence(RUN_DIR);

  // ── Run machine ───────────────────────────────────────────────────────────
  console.log('\n── Run ──────────────────────────────────────────────────────');

  const handlers = createMockHandlers();
  let prevState  = 'setup';

  const game = createOrcaMachine(def as any, {
    effectHandlers: handlers as any,
    onTransition: (state: any) => {
      sink.write(makeEntry({
        runId:        RUN_ID,
        machine:      def.name,
        event:        '',
        from:         prevState,
        to:           state.value,
        contextDelta: {},
      }));
      prevState = state.value;
    },
  });

  game.start();
  console.log(`Initial state: ${game.getState().value}`);

  game.send({ type: 'start_game' });
  game.send({ type: 'look' });

  // Save checkpoint after entering generating_narrative
  const snap = game.machine.snapshot();
  persistence.save(RUN_ID, snap);
  console.log(`\n  ✓ Checkpoint saved (state: ${snap.state})`);
  console.log(`    → ${RUN_DIR}/${RUN_ID}.json`);

  // Continue the original run
  await new Promise(resolve => setTimeout(resolve, 100));
  game.send({ type: 'llm_response' });
  game.send({ type: 'submit_command' });
  game.stop();

  // ── Resume from checkpoint ────────────────────────────────────────────────
  console.log('\n── Resume from checkpoint ───────────────────────────────────');

  const saved = persistence.load(RUN_ID);
  if (!saved) { console.log('No checkpoint found'); return; }

  let prevState2 = String(saved.state);
  const game2 = createOrcaMachine(def as any, {
    effectHandlers: handlers as any,
    onTransition: (state: any) => {
      sink.write(makeEntry({
        runId:        RUN_ID + '-resumed',
        machine:      def.name,
        event:        '',
        from:         prevState2,
        to:           state.value,
        contextDelta: {},
      }));
      prevState2 = state.value;
    },
  });

  await game2.machine.resume(saved);
  console.log(`  Resumed at state: ${game2.getState().value}`);

  game2.send({ type: 'llm_response' });
  game2.send({ type: 'submit_command' });
  game2.machine.stop();

  sink.close();
  fileSink.close();

  console.log('\n── Audit log ─────────────────────────────────────────────────');
  console.log(`  Written to: ${RUN_DIR}/audit.jsonl`);
  console.log('\n=== Test Complete ===');
}

main().catch(console.error);
