#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  parseSkill,
  verifySkill,
  compileSkill,
  generateActionsSkill,
  refineSkill,
  generateOrcaSkill,
  generateOrcaMultiSkill,
  type SkillError,
  ORCA_SYNTAX_REFERENCE,
  MULTI_MACHINE_SYNTAX_ADDENDUM,
} from '@orcalang/orca-lang/skills';
import { ORCA_TOOLS } from '@orcalang/orca-lang/tools';

const TOOLS = ORCA_TOOLS as unknown as Tool[];

// ── MCP server instructions (injected into every AI context on connect) ───────

const MCP_INSTRUCTIONS = `This MCP server exposes Orca state machine tools. Orca is a markdown-based state machine language designed for LLM code generation.

Recommended workflow: generate_machine (or write source manually) → verify_machine → refine_machine (if errors) → compile_machine → generate_actions.

${ORCA_SYNTAX_REFERENCE}

${MULTI_MACHINE_SYNTAX_ADDENDUM}`;

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
      const maxIterations = (args.max_iterations as number) ?? 3;
      return generateOrcaSkill(spec, undefined, maxIterations);
    }

    case 'generate_multi_machine': {
      const spec = args.spec as string;
      const maxIterations = (args.max_iterations as number) ?? 3;
      return generateOrcaMultiSkill(spec, undefined, maxIterations);
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

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Server setup ──────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'orca', version: '0.1.0' },
  { capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

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
