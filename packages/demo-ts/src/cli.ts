// Retro-Adventure CLI - Playable text adventure game

import { createInterface } from 'readline';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tokenize, parse, createOrcaMachine } from './runtime/orca-shim';
import { createMockHandlers, resetGameContext, getGameContext } from './runtime/handlers';
import { parseCommand, formatHelp } from './runtime/parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getStateName(value: string | object): string {
  if (typeof value === 'object') {
    return Object.keys(value)[0] || 'unknown';
  }
  return value;
}

async function main() {
  console.log('╔════════════════════════════════════════╗');
  console.log('║     RETRO ADVENTURE - ORCA DEMO       ║');
  console.log('╚════════════════════════════════════════╝\n');

  // Load and parse the game.orca file
  const orcaPath = join(__dirname, 'orca', 'game.orca');
  const source = readFileSync(orcaPath, 'utf-8');

  console.log('Loading game...');
  const parseResult = parse(tokenize(source));
  console.log(`Game: ${parseResult.machine.name}\n`);

  // Reset game state
  resetGameContext();

  // Track last narrative for display
  let lastNarrative = '';

  // Create effect handlers
  const handlers = createMockHandlers();

  // Shared state for callback
  let transitionResolve: (() => void) | null = null;

  // Create the machine
  const machine = createOrcaMachine(parseResult.machine as any, {
    effectHandlers: handlers as any,
    onTransition: (state) => {
      // Capture narrative result when available
      if (state.context._effectResult) {
        const result = state.context._effectResult as any;
        if (result.data?.narrative) {
          lastNarrative = result.data.narrative;
        }
      }

      // Resolve any pending transition wait
      if (transitionResolve) {
        transitionResolve();
        transitionResolve = null;
      }
    },
  });

  // Helper to wait for a state transition
  const waitForTransition = (): Promise<void> => {
    return new Promise((resolve) => {
      transitionResolve = resolve;
      setTimeout(() => {
        if (transitionResolve === resolve) {
          transitionResolve = null;
          resolve();
        }
      }, 2000); // 2 second timeout
    });
  };

  // Start the machine
  machine.start();
  console.log('Initializing adventure...\n');

  // Wait for initial setup transition
  await new Promise(r => setTimeout(r, 100));

  // Send start_game to transition from setup to idle
  machine.send({ type: 'start_game' });
  await waitForTransition();
  await new Promise(r => setTimeout(r, 100));

  // Display initial look
  machine.send({ type: 'look' });
  await waitForTransition();
  await new Promise(r => setTimeout(r, 300)); // Extra wait for async effect

  if (lastNarrative) {
    console.log(lastNarrative.replace(/\\n/g, '\n'));
  }
  console.log('[Ready for commands]\n');

  // If stdin is not a TTY, read commands from stdin
  if (!process.stdin.isTTY) {
    console.log('[Non-interactive mode - processing commands from stdin]\n');
    const commands: string[] = [];
    // Read all stdin into commands array
    const stdinData = await new Promise<string>((resolve) => {
      let data = '';
      process.stdin.on('data', (chunk) => data += chunk);
      process.stdin.on('end', () => resolve(data));
    });
    for (const line of stdinData.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) commands.push(trimmed);
    }
    for (const cmd of commands) {
      console.log(`> ${cmd}`);
      const parsed = parseCommand(cmd);
      if (parsed) {
        if (parsed.type === 'help') {
          console.log(formatHelp());
          continue;
        }
        if (parsed.type === 'game_over') {
          console.log('\nThanks for playing Retro Adventure!\n');
          machine.stop();
          return;
        }
        lastNarrative = '';
        machine.send(parsed);
        await waitForTransition();
        await new Promise(r => setTimeout(r, 300));

        const state = getStateName(machine.getState().value as string | object);
        if (state === 'responding') {
          machine.send({ type: 'submit_command' });
          await waitForTransition();
        }

        if (lastNarrative) {
          console.log(lastNarrative.replace(/\\n/g, '\n'));
        }
        const ctx = getGameContext();
        console.log(`[Location: ${ctx.current_location} | Score: ${ctx.score}]\n`);
      }
    }
    console.log('Thanks for playing!');
    machine.stop();
    return;
  }

  // Interactive mode with readline
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });

  rl.prompt();

  const processCommand = async (input: string) => {
    const trimmed = input.trim();

    if (!trimmed) {
      rl.prompt();
      return;
    }

    const parsed = parseCommand(trimmed);

    if (!parsed) {
      console.log("I don't understand that.\n");
      rl.prompt();
      return;
    }

    if (parsed.type === 'help') {
      console.log(formatHelp());
      rl.prompt();
      return;
    }

    if (parsed.type === 'game_over') {
      console.log('\nThanks for playing Retro Adventure!\n');
      rl.close();
      machine.stop();
      return;
    }

    if (parsed.type === 'invalid_command') {
      console.log("I don't understand that command. Type 'help' for a list of commands.\n");
      rl.prompt();
      return;
    }

    // Send command and wait for response
    lastNarrative = '';
    machine.send(parsed);

    // Wait for transition
    await waitForTransition();

    // For narrative-generating commands, wait extra time for async effect
    const state = getStateName(machine.getState().value as string | object);
    if (state === 'responding') {
      // We're in responding, submit_command will return to idle
      machine.send({ type: 'submit_command' });
      await waitForTransition();
    } else if (state === 'generating_narrative') {
      // Wait extra for the async effect to complete
      await new Promise(r => setTimeout(r, 300));
    }

    // Display result
    if (lastNarrative) {
      console.log(lastNarrative.replace(/\\n/g, '\n'));
    }

    const ctx = getGameContext();
    console.log(`\n[Location: ${ctx.current_location} | Inventory: ${ctx.inventory.join(', ') || 'empty'} | Score: ${ctx.score}]\n`);

    rl.prompt();
  };

  rl.on('line', processCommand);

  rl.on('close', () => {
    machine.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
