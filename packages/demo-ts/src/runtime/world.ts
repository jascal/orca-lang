// Simple world map for retro-adventure game

export interface Location {
  name: string;
  description: string;
  exits: Record<string, string>; // direction -> locationId
  items: string[];
}

export interface World {
  [locationId: string]: Location;
}

export const WORLD: World = {
  start: {
    name: 'Forest Clearing',
    description: 'Tall ancient trees surround you. Shafts of sunlight pierce the canopy. A well-worn path leads north.',
    exits: { north: 'village' },
    items: ['torch'],
  },
  village: {
    name: 'Village Square',
    description: 'A quiet village square. Stone buildings line the edges. The smell of fresh bread drifts from a nearby bakery. Paths lead south and east.',
    exits: { south: 'start', east: 'cave', north: 'mountain' },
    items: ['key'],
  },
  cave: {
    name: 'Dark Cave',
    description: 'A damp cave with crystalline formations on the walls. Water drips somewhere in the darkness. The air is cool and still. The only exit is west.',
    exits: { west: 'village' },
    items: ['sword', 'gold'],
  },
  mountain: {
    name: 'Mountain Pass',
    description: 'A winding path up the mountainside. The wind howls fiercely here. You can see the entire valley spread out below. The only way is back south.',
    exits: { south: 'village' },
    items: ['gem'],
  },
};

export function getLocation(locationId: string): Location | undefined {
  return WORLD[locationId];
}

export function describeLocation(locationId: string): string {
  const loc = WORLD[locationId];
  if (!loc) return 'You are lost in an undefined void.';

  let desc = `${loc.name}\n\n${loc.description}`;

  if (loc.items.length > 0) {
    desc += `\n\nYou see: ${loc.items.join(', ')}.`;
  }

  const exitList = Object.entries(loc.exits).map(([dir, _dest]) => dir).join(', ');
  desc += `\n\nExits: ${exitList}.`;

  return desc;
}
