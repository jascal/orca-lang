/**
 * LLM effect — calls the Anthropic API to gather context and generate file changes.
 *
 * Auth resolution order:
 *   1. ANTHROPIC_API_KEY environment variable
 *   2. ~/.orca/auth_profiles.json (the orca auth store, profile "default")
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { PhaseStep, FileChange, LLMChangesResponse, LLMContextResponse } from '../types.js';

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 8192;

function getApiKey(): string {
  if (process.env.ANTHROPIC_API_KEY) {
    return process.env.ANTHROPIC_API_KEY;
  }

  const storePath = join(homedir(), '.orca', 'auth_profiles.json');
  if (existsSync(storePath)) {
    try {
      const store = JSON.parse(readFileSync(storePath, 'utf-8')) as {
        profiles?: Record<string, { api_key?: string; provider?: string }>;
      };
      for (const profile of Object.values(store.profiles ?? {})) {
        if (profile.api_key && (profile.provider === 'anthropic' || !profile.provider)) {
          return profile.api_key;
        }
      }
    } catch {
      // ignore parse errors
    }
  }

  throw new Error(
    'No Anthropic API key found. Set ANTHROPIC_API_KEY or run: orca auth login'
  );
}

async function callAnthropic(system: string, user: string): Promise<string> {
  const apiKey = getApiKey();

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${text}`);
  }

  const data = await response.json() as {
    content: Array<{ type: string; text: string }>;
  };
  const textBlock = data.content.find(c => c.type === 'text');
  return textBlock?.text ?? '';
}

/**
 * Ask the LLM which files in the repo are relevant for implementing this step.
 * Returns a list of relative file paths.
 */
export async function gatherContextFiles(
  step: PhaseStep,
  repoRoot: string
): Promise<string[]> {
  const claudeMd = tryRead(join(repoRoot, 'CLAUDE.md'));
  const packagesClaude = tryRead(join(repoRoot, 'packages', 'orca-lang', 'CLAUDE.md'));

  const system = `You are helping implement a feature step in the Orca state machine language monorepo.

Your task: identify the most relevant source files in the repo that need to be read to implement the given step.

IMPORTANT: Respond ONLY with valid JSON. No markdown, no explanation outside the JSON.

Format:
{
  "files": ["relative/path/from/repo/root", ...],
  "reasoning": "brief explanation"
}

Rules:
- Include at most 15 files
- Prefer specific source files over broad docs
- Include test files that would need to be updated
- All paths must be relative to the repo root`;

  const user = `## Step to implement

Step ID: ${step.id}
Title: ${step.title}
Deliverable: ${step.deliverable}

Description:
${step.description}

## Repo overview (CLAUDE.md)

${claudeMd ?? '(not found)'}

## Core package details

${packagesClaude ?? '(not found)'}`;

  const raw = await callAnthropic(system, user);
  const parsed = parseJson<LLMContextResponse>(raw);
  return parsed?.files ?? [];
}

/**
 * Ask the LLM to generate the file changes needed to implement this step.
 * Returns structured file changes ready to apply to disk.
 */
export async function generateFileChanges(
  step: PhaseStep,
  contextFiles: Array<{ path: string; content: string }>,
  testOutput?: string
): Promise<LLMChangesResponse> {
  const system = `You are an expert TypeScript developer implementing a feature step in the Orca state machine language monorepo.

Orca is a TypeScript/Python/Go monorepo. Core language in packages/orca-lang, TypeScript runtime in packages/runtime-ts.
Files use ESM imports with explicit .js extensions (e.g., import x from './foo.js').
TypeScript is strict mode with NodeNext module resolution.

IMPORTANT: Respond ONLY with valid JSON. No markdown code fences, no explanation outside the JSON.

Format:
{
  "files": [
    {
      "path": "relative/path/from/repo/root",
      "operation": "create" or "overwrite",
      "content": "complete file content"
    }
  ],
  "commit_message": "imperative commit message under 72 chars",
  "explanation": "what was implemented and why"
}

Rules:
- Write complete, production-quality TypeScript
- Use explicit .js extensions in all imports
- Export only what is needed
- Do not add comments explaining the step — write clean code
- All paths relative to repo root`;

  const contextSection = contextFiles
    .map(f => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
    .join('\n\n');

  const retrySection = testOutput
    ? `\n## Previous attempt failed — test output\n\`\`\`\n${testOutput}\n\`\`\`\nFix the issues shown above.`
    : '';

  const user = `## Step to implement

Step ID: ${step.id}
Title: ${step.title}
Deliverable: ${step.deliverable}

${step.description}
${retrySection}

## Relevant source files

${contextSection}`;

  const raw = await callAnthropic(system, user);
  const parsed = parseJson<LLMChangesResponse>(raw);

  if (!parsed?.files) {
    throw new Error(`LLM returned invalid response: ${raw.slice(0, 200)}`);
  }

  return parsed;
}

function tryRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

function parseJson<T>(raw: string): T | null {
  // Strip markdown code fences if present
  const cleaned = raw
    .replace(/^```json\s*/m, '')
    .replace(/^```\s*/m, '')
    .replace(/```\s*$/m, '')
    .trim();

  // Find the first { to handle leading text
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return null;

  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
