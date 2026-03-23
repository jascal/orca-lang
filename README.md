# Orca

**Orca (Orchestrated State Machine Language)** — an LLM-native code generation target that separates program topology (the state machine structure) from computation (individual action functions).

The core insight: LLMs generate flat transition tables reliably, and Orca's topology verifier ensures structural correctness that LLMs struggle to guarantee on their own.

## Quick Start

```bash
# Parse and verify a machine
npx tsx src/index.ts verify examples/simple-toggle.orca

# Compile to XState v5
npx tsx src/index.ts compile xstate examples/payment-processor.orca

# Compile to Mermaid diagram
npx tsx src/index.ts compile mermaid examples/text-adventure.orca

# Visualize (output Mermaid for rendering)
npx tsx src/index.ts visualize examples/simple-toggle.orca
```

## Installation

```bash
npm install
npm run build
```

## CLI Skills

Orca's CLI exposes structured skills designed for LLM consumption:

```bash
orca /verify-orca examples/payment-processor.orca
orca /compile-orca xstate examples/payment-processor.orca
orca /generate-actions examples/payment-processor.orca typescript
```

## Architecture

```
Source (.orca) → Lexer → Parser → AST → Verifier → Compiler → Output (XState/Mermaid)
```

- **`src/parser/`** — Hand-written recursive descent parser
- **`src/verifier/`** — Topology checks (reachability, deadlock, completeness, determinism)
- **`src/compiler/`** — XState v5 and Mermaid compilation targets
- **`src/llm/`** — LLM provider abstraction (Anthropic, OpenAI, Grok, Ollama)
- **`src/generators/`** — Code generator registry for action implementations

## LLM Integration

Orca uses its own LLM configuration, separate from the ambient context.

### Setup

1. **Copy the example env file:**
   ```bash
   cp .env.example .env
   ```

2. **Add your API key** to `.env`:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```

3. **Configure** in `orca.yaml`:
   ```yaml
   provider: anthropic
   model: claude-sonnet-4-6
   code_generator: typescript
   ```

### Supported Providers

| Provider | Environment Variable | Notes |
|----------|-------------------|-------|
| Anthropic | `ANTHROPIC_API_KEY` | Default |
| OpenAI | `OPENAI_API_KEY` | |
| xAI (Grok) | `XAI_API_KEY` | |
| Ollama | — | Set `base_url: http://localhost:11434` |

### Authentication

Orca supports two authentication methods:

**1. API Key (simple)**
```bash
cp .env.example .env
# Edit .env and add your API key
```

**2. OAuth (for organization/team billing)**
```bash
# Login with OAuth (supports Anthropic, MiniMax)
orca login --provider anthropic

# Check auth status
orca auth

# Logout
orca logout
```

Credentials are stored in `~/.orca/auth_profiles.json`.

### Generate Action Implementations

```bash
# Without LLM (template-based, no API key needed)
orca actions examples/payment-processor.orca

# With LLM (requires API key)
orca /generate-actions --use-llm examples/payment-processor.orca typescript

# Output to directory (one file per action)
orca /generate-actions --use-llm examples/payment-processor.orca --output ./actions/

# Output to single file (all actions combined)
orca /generate-actions --use-llm examples/payment-processor.orca --output ./actions.ts
```

See [docs/orca-proposal.md](docs/orca-proposal.md) for the full design specification.

## License

Apache License 2.0 — see [LICENSE](LICENSE)
