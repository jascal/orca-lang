import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { AuthProfileStore, AuthProfile } from './types.js';

const STORE_VERSION = 1;

export function getOrcaDir(): string {
  return join(homedir(), '.orca');
}

export function getAuthStorePath(): string {
  return join(getOrcaDir(), 'auth_profiles.json');
}

export function ensureOrcaDir(): void {
  const dir = getOrcaDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { mode: 0o700, recursive: true });
  }
}

export function loadAuthStore(): AuthProfileStore {
  const path = getAuthStorePath();
  ensureOrcaDir();

  if (!existsSync(path)) {
    return { version: STORE_VERSION, profiles: {} };
  }

  try {
    const content = readFileSync(path, 'utf-8');
    const store = JSON.parse(content) as AuthProfileStore;
    return {
      version: store.version ?? STORE_VERSION,
      profiles: store.profiles ?? {},
    };
  } catch {
    return { version: STORE_VERSION, profiles: {} };
  }
}

export function saveAuthStore(store: AuthProfileStore): void {
  const path = getAuthStorePath();
  ensureOrcaDir();

  // Set restrictive permissions (owner read/write only)
  writeFileSync(path, JSON.stringify(store, null, 2), { mode: 0o600 });
}

export function getAuthProfile(profileId: string): AuthProfile | null {
  const store = loadAuthStore();
  return store.profiles[profileId] ?? null;
}

export function setAuthProfile(profileId: string, profile: AuthProfile): void {
  const store = loadAuthStore();
  store.profiles[profileId] = profile;
  saveAuthStore(store);
}

export function deleteAuthProfile(profileId: string): boolean {
  const store = loadAuthStore();
  if (store.profiles[profileId]) {
    delete store.profiles[profileId];
    saveAuthStore(store);
    return true;
  }
  return false;
}

export function listAuthProfiles(): string[] {
  const store = loadAuthStore();
  return Object.keys(store.profiles);
}
