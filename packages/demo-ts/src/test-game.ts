// Test script for retro-adventure-orca game machine
// Compiles game.orca and executes it with effect handlers

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tokenize, parse, createOrcaMachine } from './runtime/orca-shim';
import { createMockHandlers } from './runtime/handlers';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
  console.log('=== Retro-Adventure Orca Test ===\n');

  // Load and parse the game.orca.md file
  const orcaPath = join(__dirname, 'orca', 'game.orca.md');
  console.log(`Loading Orca file: ${orcaPath}`);
  const source = readFileSync(orcaPath, 'utf-8');

  console.log('Parsing Orca source...');
  const parseResult = parse(tokenize(source));
  console.log(`Parsed machine: ${parseResult.machine.name}`);
  console.log(`  States: ${parseResult.machine.states.length}`);
  console.log(`  Events: ${parseResult.machine.events.length}`);
  console.log(`  Transitions: ${parseResult.machine.transitions.length}`);
  console.log(`  Actions: ${parseResult.machine.actions.length}`);

  // Show effectful actions
  const effectfulActions = parseResult.machine.actions.filter(a => a.hasEffect);
  console.log(`  Effectful actions: ${effectfulActions.map(a => `${a.name} (${a.effectType})`).join(', ') || 'none'}`);

  // Create effect handlers
  const handlers = createMockHandlers();

  // Create the machine - pass the machine def directly, createOrcaMachine will compile it
  console.log('\nCreating Orca machine...');
  const machine = createOrcaMachine(parseResult.machine as any, {
    effectHandlers: handlers as any,
    onTransition: (state) => {
      console.log(`  → Transition to: ${state.value}`);
    },
  });

  // Start the machine
  console.log('\nStarting machine...');
  machine.start();
  console.log('Initial state:', machine.getState().value);

  // Send start_game event
  console.log('\nSending start_game event...');
  machine.send({ type: 'start_game' });
  console.log('State after start_game:', machine.getState().value);

  // Send look event
  console.log('\nSending look event...');
  machine.send({ type: 'look' });
  console.log('State after look:', machine.getState().value);

  // Wait a bit for any async effects
  await new Promise(resolve => setTimeout(resolve, 200));

  // Send llm_response to continue from generating_narrative
  console.log('\nSending llm_response event...');
  machine.send({ type: 'llm_response' });
  console.log('State after llm_response:', machine.getState().value);

  // Send submit_command to go back to idle
  console.log('\nSending submit_command event...');
  machine.send({ type: 'submit_command' });
  console.log('State after submit_command:', machine.getState().value);

  // Stop the machine
  console.log('\nStopping machine...');
  machine.stop();

  console.log('\n=== Test Complete ===');
}

main().catch(console.error);
