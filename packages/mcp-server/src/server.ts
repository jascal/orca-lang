#!/usr/bin/env node

import { createRequire } from 'module';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  parseSkill,
  verifySkill,
  compileSkill,
  generateActionsSkill,
  refineSkill,
  generateAutoSkill,
  generateOrcaMultiDraftSkill,
  type SkillError,
} from '@orcalang/orca-lang/skills';
import { ORCA_TOOLS } from '@orcalang/orca-lang/tools';

const _require = createRequire(import.meta.url);
const { version: SERVER_VERSION } = _require('../package.json') as { version: string };

// ── Node.js version check ─────────────────────────────────────────────────────
const [major] = process.version.slice(1).split('.').map(Number);
if (major < 20) {
  console.error(`ERROR: @orcalang/orca-mcp-server requires Node.js 20 or later. Current version: ${process.version}`);
  process.exit(1);
}

const TOOLS = ORCA_TOOLS as unknown as Tool[];

// ── MCP server instructions (injected into every AI context on connect) ───────

// Compact syntax reference — under 400 tokens
const MCP_INSTRUCTIONS = `Orca MCP Server — state machine generation tools. Workflow: generate_machine → verify_machine → refine_machine (if errors) → compile_machine → generate_actions.

## Syntax Reference
# machine Name           // required heading
## state Name [initial] // one [initial] required; [final] for terminal states
## state Name [final]
## transitions         // table: | Source | Event | Guard | Target | Action |
## actions            // table: | Name | Signature |

Minimal example (toggle):
\`\`\`
# machine Toggle
## state off [initial]
## state on
## transitions
| off | toggle | | on | increment |
| on  | toggle | | off | increment |
## actions
| Name | Signature |
| increment | \`(ctx) -> Context\` |
\`\`\`

## Key Rules
- [initial] and [final] are the ONLY syntax for initial/final states
- Guards: ctx.field comparisons (< > == != <= >=), null checks, boolean ops (and/or/not). NO method calls.
- Effect actions: \`(ctx) -> Context + Effect<T>\`
- Transitions reference actions by name only — no action bodies in Orca
- Multi-machine: separate files with ---, use invoke: ChildMachine in states
`;

// ── Tool dispatch ─────────────────────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'parse_machine': {
      const source = args.source as string;
      return parseSkill({ source });
    }

    case 'verify_machine': {
      const source = args.source as string;
      return verifySkill({ source });
    }

    case 'compile_machine': {
      const source = args.source as string;
      const target = (args.target as 'xstate' | 'mermaid') ?? 'xstate';
      return compileSkill({ source }, target);
    }

    case 'generate_machine': {
      const spec = args.spec as string;
      return generateAutoSkill(spec);
    }

    case 'generate_multi_machine': {
      const spec = args.spec as string;
      return generateOrcaMultiDraftSkill(spec);
    }

    case 'generate_actions': {
      const source = args.source as string;
      const lang = (args.lang as string) ?? 'typescript';
      const useLLM = (args.use_llm as boolean) ?? false;
      const generateTests = (args.generate_tests as boolean) ?? false;
      return generateActionsSkill({ source }, lang, useLLM, undefined, generateTests);
    }

    case 'refine_machine': {
      const source = args.source as string;
      const maxIterations = (args.max_iterations as number) ?? 3;

      let errors = args.errors as SkillError[] | undefined;
      if (!errors) {
        // Auto-verify if errors not provided
        const verification = await verifySkill({ source });
        if (verification.status === 'valid') {
          return { status: 'success', corrected: source, iterations: 0, changes: ['Machine already valid — no refinement needed'] };
        }
        errors = verification.errors.filter(e => e.severity === 'error');
      }

      return refineSkill({ source }, errors, undefined, maxIterations);
    }

    case 'server_status': {
      const apiKeyConfigured =
        !!(process.env.ORCA_API_KEY ||
           process.env.ANTHROPIC_API_KEY ||
           process.env.OPENAI_API_KEY ||
           process.env.MINIMAX_API_KEY);
      return {
        version: SERVER_VERSION,
        node_version: process.version,
        provider: process.env.ORCA_PROVIDER ?? 'anthropic',
        model: process.env.ORCA_MODEL ?? 'claude-sonnet-4-6',
        base_url: process.env.ORCA_BASE_URL ?? null,
        code_generator: process.env.ORCA_CODE_GENERATOR ?? 'typescript',
        max_tokens: process.env.ORCA_MAX_TOKENS ? parseInt(process.env.ORCA_MAX_TOKENS, 10) : 4096,
        temperature: process.env.ORCA_TEMPERATURE ? parseFloat(process.env.ORCA_TEMPERATURE) : 0.7,
        api_key_configured: apiKeyConfigured,
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Server setup ──────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'orca', version: '0.1.0' },
  { capabilities: { tools: {}, resources: {} }, instructions: MCP_INSTRUCTIONS },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// ── Resources ────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
// Examples are in packages/orca-lang/examples (sibling package to mcp-server)
// From packages/mcp-server/dist: ../../../packages/orca-lang/examples
const EXAMPLES_DIR = resolve(__dirname, '../../../packages/orca-lang/examples');

// Grammar spec content (loaded lazily to avoid bundling large strings)
let grammarSpecContent: string | null = null;
function getGrammarSpec(): string {
  if (!grammarSpecContent) {
    try {
      grammarSpecContent = readFileSync(resolve(__dirname, '../../../docs/orca-md-grammar-spec.md'), 'utf-8');
    } catch {
      grammarSpecContent = '# Orca Grammar Specification\n\nGrammar spec not found. See AGENTS.md for syntax reference.';
    }
  }
  return grammarSpecContent;
}

// Example files to expose as resources
const EXAMPLES: { name: string; file: string }[] = [
  { name: 'simple-toggle', file: 'simple-toggle.orca.md' },
  { name: 'payment-processor', file: 'payment-processor.orca.md' },
];

const ORCA_RESOURCES = [
  {
    uri: 'orca://grammar',
    name: 'Orca Grammar Specification',
    description: 'Full grammar reference for .orca.md files — headings, tables, transitions, guards, actions, effects, and multi-machine syntax.',
    mimeType: 'text/markdown',
  },
  ...EXAMPLES.map(({ name }) => ({
    uri: `orca://examples/${name}`,
    name: `Example: ${name}`,
    description: `Example Orca machine: ${name}.orca.md`,
    mimeType: 'text/markdown',
  })),
];

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: ORCA_RESOURCES,
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;

  if (uri === 'orca://grammar') {
    return {
      contents: [{
        uri,
        mimeType: 'text/markdown',
        text: getGrammarSpec(),
      }],
    };
  }

  const exampleMatch = uri.match(/^orca:\/\/examples\/([\w-]+)$/);
  if (exampleMatch) {
    const exampleName = exampleMatch[1];
    const example = EXAMPLES.find(e => e.name === exampleName);
    if (example) {
      try {
        const content = readFileSync(resolve(EXAMPLES_DIR, example.file), 'utf-8');
        return {
          contents: [{
            uri,
            mimeType: 'text/markdown',
            text: content,
          }],
        };
      } catch {
        return {
          contents: [{
            uri,
            mimeType: 'text/plain',
            text: `Example "${exampleName}" not found.`,
          }],
        };
      }
    }
  }

  return {
    contents: [{
      uri,
      mimeType: 'text/plain',
      text: `Resource not found: ${uri}`,
    }],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    const result = await callTool(name, args as Record<string, unknown>);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: err instanceof Error ? err.message : String(err),
        },
      ],
    };
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
