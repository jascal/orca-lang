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
      'Parse an Orca machine definition and return its structure as JSON (states, events, transitions, guards, actions, context). Supports single and multi-machine files. Source must use "# machine Name" heading, "## state Name [initial]" for states, and a "## transitions" section with a | Source | Event | Guard | Target | Action | table.',
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
      'Verify an Orca machine definition for structural correctness, completeness, and determinism. Checks that exactly one [initial] state exists, all states are reachable, no deadlocks exist (every non-final state handles all events or has timeouts), and guards on competing transitions are mutually exclusive. Returns structured errors and warnings.',
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
      'Compile a verified Orca machine to XState v5 config (TypeScript) or Mermaid stateDiagram-v2. Run verify_machine first to catch errors before compiling.',
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
      'Generate a draft Orca machine definition from a natural language specification. Automatically chooses between a single-machine or multi-machine design based on the spec: specs that mention a coordinator, orchestrator, or multiple independently-lifecycled sub-processes route to multi-machine; everything else produces a single machine. Returns raw .orca.md source and an is_multi flag. Always call verify_machine on the result next — then refine_machine if there are errors. Requires LLM configuration via environment variables (ANTHROPIC_API_KEY, etc.).',
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
      'Generate action scaffold code for an Orca machine in TypeScript, Python, or Go. Includes registration comments and optional test scaffolds. Requires a successfully parsed machine — pass verified .orca.md source.',
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
      'Generate a draft set of coordinated Orca machines from a natural language specification. Returns multiple machine definitions in one .orca.md file (separated by ---). Always call verify_machine on the result next — then refine_machine if there are errors. Requires LLM configuration via environment variables.',
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
      'Fix verification errors in an Orca machine using an LLM. Loops until the machine is valid or max_iterations is reached. If errors are not provided, verification runs automatically first. Use this after verify_machine returns errors.',
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
];
