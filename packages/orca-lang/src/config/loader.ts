import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import yaml from 'js-yaml';
import { OrcaConfig, DEFAULT_CONFIG } from './types.js';

let envLoaded = false;

function loadEnvFile(): void {
  if (envLoaded) return;
  envLoaded = true;

  // Load from project root .env
  const cwd = process.cwd();
  const envPath = join(cwd, '.env');
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();
      // Remove surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && !process.env[key]) {
        process.env[key] = value;
      }
    }
  }
}

function interpolateEnvVars(obj: unknown): unknown {
  if (typeof obj === 'string') {
    // Replace ${VAR_NAME} with environment variable value
    return obj.replace(/\$\{([^}]+)\}/g, (_, varName) => {
      const value = process.env[varName];
      if (value === undefined) {
        throw new Error(`Environment variable ${varName} is not set`);
      }
      return value;
    });
  }
  if (Array.isArray(obj)) {
    return obj.map(interpolateEnvVars);
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = interpolateEnvVars(value);
    }
    return result;
  }
  return obj;
}

function deepMerge(target: OrcaConfig, source: Partial<OrcaConfig>): OrcaConfig {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value !== null) {
      (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}

export function loadConfig(configPath?: string): OrcaConfig {
  loadEnvFile();
  const configs: Partial<OrcaConfig>[] = [];

  // 1. Global default
  const globalConfigPath = join(homedir(), '.orca', 'default.yaml');
  if (existsSync(globalConfigPath)) {
    const content = readFileSync(globalConfigPath, 'utf-8');
    const parsed = yaml.load(content) as Record<string, unknown>;
    configs.push(interpolateEnvVars(parsed) as Partial<OrcaConfig>);
  }

  // 2. Project config (current working directory or specified path)
  const projectConfigPath = configPath || findProjectConfig();
  if (projectConfigPath && existsSync(projectConfigPath)) {
    const content = readFileSync(projectConfigPath, 'utf-8');
    const parsed = yaml.load(content) as Record<string, unknown>;
    configs.push(interpolateEnvVars(parsed) as Partial<OrcaConfig>);
  }

  // 3. Merge all configs in order (later ones override earlier)
  let result = DEFAULT_CONFIG;
  for (const config of configs) {
    result = deepMerge(result, config);
  }

  return result;
}

function findProjectConfig(): string | undefined {
  const cwd = process.cwd();
  const possiblePaths = [
    join(cwd, 'orca.yaml'),
    join(cwd, '.orca.yaml'),
    join(cwd, 'orca', 'orca.yaml'),
  ];

  for (const path of possiblePaths) {
    if (existsSync(path)) {
      return path;
    }
  }

  return undefined;
}

export function resolveConfigOverrides(
  config: OrcaConfig,
  overrides: Partial<OrcaConfig>
): OrcaConfig {
  return deepMerge(config, overrides);
}
