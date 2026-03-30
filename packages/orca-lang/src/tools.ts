/** Shared Orca tool descriptors — used by the CLI (--tools --json) and the MCP server. */

export interface ToolInputSchema {
  type: 'object';
  properties: Record<string, { type: string; description?: string; enum?: string[]; items?: Record<string, unknown> }>;
  required: string[];
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
}

export const ORCA_TOOLS: ToolDef[] = [
  {
    name: 'parse_machine',
    description:
      'Parse .orca.md source → JSON (states, events, transitions, guards, actions, context). Syntax: # machine Name, ## state Name [initial|final], ## transitions table (| Source | Event | Guard | Target | Action |).',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Raw .orca.md content. Must start with "# machine Name". States use "## state Name [initial|final]". Transitions use a markdown table with columns: Source, Event, Guard, Target, Action.' },
      },
      required: ['source'],
    },
  },
  {
    name: 'verify_machine',
    description:
      'Verify machine structure: checks [initial] presence (exactly one), reachability, no deadlocks, guard determinism. Returns structured errors with codes and suggestions. Run before compile_machine.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Raw .orca.md content. Must start with "# machine Name". States use "## state Name [initial|final]". Transitions use a markdown table with columns: Source, Event, Guard, Target, Action.' },
      },
      required: ['source'],
    },
  },
  {
    name: 'compile_machine',
    description:
      'Compile verified machine to XState v5 TypeScript or Mermaid stateDiagram-v2. Run verify_machine first. target: "xstate" (default) or "mermaid".',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Raw .orca.md content. Must start with "# machine Name". States use "## state Name [initial|final]". Transitions use a markdown table with columns: Source, Event, Guard, Target, Action.' },
        target: {
          type: 'string',
          enum: ['xstate', 'mermaid'],
          description: 'Compilation target (default: xstate)',
        },
      },
      required: ['source'],
    },
  },
  {
    name: 'generate_machine',
    description:
      'Generate draft .orca.md from natural language spec. Returns source + is_multi flag. Always verify_machine next, then refine_machine if errors. Requires LLM API key (ANTHROPIC_API_KEY, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        spec: {
          type: 'string',
          description: 'Natural language description of the desired state machine',
        },
      },
      required: ['spec'],
    },
  },
  {
    name: 'generate_actions',
    description:
      'Generate action scaffold code from verified machine. lang: typescript (default), python, or go. Pass verified .orca.md source. use_llm: true for implementations vs templates. generate_tests: true for test scaffolds.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Raw .orca.md content of a valid machine. Actions in the "## actions" table (| Name | Signature |) will have stubs generated.' },
        lang: {
          type: 'string',
          enum: ['typescript', 'python', 'go'],
          description: 'Target language (default: typescript)',
        },
        use_llm: {
          type: 'boolean',
          description: 'Use LLM to generate implementations instead of templates (default: false)',
        },
        generate_tests: {
          type: 'boolean',
          description: 'Include test scaffolds in the output (default: false)',
        },
      },
      required: ['source'],
    },
  },
  {
    name: 'generate_multi_machine',
    description:
      'Generate coordinated multi-machine .orca.md from spec (machines separated by ---). Use invoke: ChildMachine in states. Always verify_machine next, then refine_machine if errors. Requires LLM API key.',
    inputSchema: {
      type: 'object',
      properties: {
        spec: {
          type: 'string',
          description: 'Natural language description of the desired multi-machine system',
        },
      },
      required: ['spec'],
    },
  },
  {
    name: 'refine_machine',
    description:
      'Fix verify_machine errors using LLM. Loops until valid or max_iterations (default: 3). Pass errors array from verify_machine output, or omit to auto-verify first.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Raw .orca.md content with errors. Must use "# machine Name" heading and proper Orca markdown syntax.' },
        errors: {
          type: 'array',
          description:
            'Verification errors from verify_machine. If omitted, verification runs automatically.',
          items: {
            type: 'object',
          },
        },
        max_iterations: {
          type: 'number',
          description: 'Maximum refinement iterations (default: 3)',
        },
      },
      required: ['source'],
    },
  },
  {
    name: 'server_status',
    description:
      'Return MCP server version, active LLM provider/model, and configuration. API keys are never exposed — only whether a key is configured.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];
