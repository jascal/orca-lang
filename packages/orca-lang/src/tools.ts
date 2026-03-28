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
      'Parse an Orca machine definition and return its structure as JSON (states, events, transitions, guards, actions, context). Supports single and multi-machine files.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Raw .orca.md content' },
      },
      required: ['source'],
    },
  },
  {
    name: 'verify_machine',
    description:
      'Verify an Orca machine definition for structural correctness, completeness, and determinism. Returns structured errors and warnings.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Raw .orca.md content' },
      },
      required: ['source'],
    },
  },
  {
    name: 'compile_machine',
    description:
      'Compile an Orca machine to XState v5 config (TypeScript) or Mermaid stateDiagram-v2.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Raw .orca.md content' },
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
      'Generate an Orca machine definition from a natural language specification. Requires LLM configuration via environment variables (ANTHROPIC_API_KEY, etc.). Loops up to max_iterations to produce a valid machine.',
    inputSchema: {
      type: 'object',
      properties: {
        spec: {
          type: 'string',
          description: 'Natural language description of the desired state machine',
        },
        max_iterations: {
          type: 'number',
          description: 'Maximum refinement iterations (default: 3)',
        },
      },
      required: ['spec'],
    },
  },
  {
    name: 'generate_actions',
    description:
      'Generate action scaffold code for an Orca machine in TypeScript, Python, or Go. Includes registration comments and optional test scaffolds.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Raw .orca.md content' },
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
      'Generate a coordinated set of Orca machines from a natural language specification. Returns multiple machine definitions in one .orca.md file (separated by ---) that pass the cross-machine verifier. Requires LLM configuration via environment variables.',
    inputSchema: {
      type: 'object',
      properties: {
        spec: {
          type: 'string',
          description: 'Natural language description of the desired multi-machine system',
        },
        max_iterations: {
          type: 'number',
          description: 'Maximum refinement iterations (default: 3)',
        },
      },
      required: ['spec'],
    },
  },
  {
    name: 'refine_machine',
    description:
      'Fix verification errors in an Orca machine using an LLM. Loops until the machine is valid or max_iterations is reached. If errors are not provided, verification runs automatically first.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Raw .orca.md content with errors' },
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
];
