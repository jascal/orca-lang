// Command parser for retro-adventure game
// Maps player text input to machine events

export interface ParsedCommand {
  type: string;
  [key: string]: any;
}

// Direction aliases
const DIRECTION_ALIASES: Record<string, string> = {
  n: 'north',
  s: 'south',
  e: 'east',
  w: 'west',
  ne: 'northeast',
  nw: 'northwest',
  se: 'southeast',
  sw: 'southwest',
  u: 'up',
  d: 'down',
};

function normalizeDirection(word: string): string {
  return DIRECTION_ALIASES[word.toLowerCase()] || word.toLowerCase();
}

export function parseCommand(input: string): ParsedCommand | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;

  const words = trimmed.split(/\s+/);
  const verb = words[0];
  const rest = words.slice(1).join(' ');

  // Simple single-word commands
  switch (verb) {
    case 'look':
    case 'l':
    case 'examine':
      return { type: 'look' };

    case 'inventory':
    case 'inv':
    case 'i':
      return { type: 'inventory' };

    case 'quit':
    case 'q':
    case 'exit':
      return { type: 'game_over' };

    case 'save':
      return { type: 'save' };

    case 'load':
      return { type: 'load' };

    case 'help':
    case 'h':
    case '?':
      return { type: 'help' };
  }

  // Movement commands
  if (verb === 'go' || verb === 'walk' || verb === 'move') {
    const dir = normalizeDirection(rest);
    return { type: 'move', direction: dir };
  }

  // Direct direction commands (just "north", "n", etc.)
  const singleDir = normalizeDirection(verb);
  if (['north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast', 'southwest', 'up', 'down'].includes(singleDir)) {
    return { type: 'move', direction: singleDir };
  }

  // Take/drop commands
  if (verb === 'take' || verb === 'get' || verb === 'pick') {
    const item = rest.replace(/^up\s+/, '').trim(); // handle "pick up"
    return { type: 'take', item };
  }

  if (verb === 'drop' || verb === 'put') {
    return { type: 'drop', item: rest };
  }

  if (verb === 'use') {
    return { type: 'use', item: rest };
  }

  if (verb === 'talk' || verb === 'speak') {
    return { type: 'talk', target: rest || 'npc' };
  }

  if (verb === 'examine' || verb === 'inspect' || verb === 'check') {
    return { type: 'examine', target: rest };
  }

  return { type: 'invalid_command' };
}

export function formatHelp(): string {
  return `
Available commands:
  look, l          - Look around
  go <direction>  - Move (north/n, south/s, east/e, west/w, etc.)
  <direction>      - Shortcut for go <direction>
  take <item>      - Pick up an item
  drop <item>      - Drop an item
  use <item>       - Use an item
  inventory, i     - Show inventory
  save             - Save game
  load             - Load game
  quit             - Quit game
  help             - Show this help
`;
}
