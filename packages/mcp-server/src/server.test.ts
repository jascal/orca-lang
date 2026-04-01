import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = resolve(__dirname, '../dist/server.js');

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

async function sendMcpRequest(
  server: ReturnType<typeof spawn>,
  method: string,
  params: Record<string, unknown> = {},
  id: number | string = 1
): Promise<JsonRpcMessage> {
  const request: JsonRpcMessage = {
    jsonrpc: '2.0',
    id,
    method,
    params,
  };

  return new Promise((resolve, reject) => {
    let data = '';
    server.stdout!.on('data', (chunk: Buffer) => {
      data += chunk.toString();
      try {
        const lines = data.split('\n').filter((l) => l.trim());
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            if (parsed.id === id) {
              resolve(parsed);
            }
          } catch {
            // Not JSON yet, continue accumulating
          }
        }
      } catch (e) {
        reject(e);
      }
    });
    server.stderr?.on('data', (chunk: Buffer) => {
      console.error('Server stderr:', chunk.toString());
    });

    server.stdin!.write(JSON.stringify(request) + '\n');

    // Timeout after 5 seconds
    setTimeout(() => {
      reject(new Error(`Timeout waiting for response to ${method}`));
    }, 5000);
  });
}

function createServer(): ReturnType<typeof spawn> {
  return spawn('node', [SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });
}

describe('Orca MCP Server', () => {
  let server: ReturnType<typeof spawn>;

  beforeAll(async () => {
    server = createServer();
    server.stdout!.setMaxListeners(20);
    server.stderr!.setMaxListeners(20);
    // Wait for server to start
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 500);
      server.stdout!.on('data', (chunk: Buffer) => {
        const data = chunk.toString();
        if (data.includes('"id"')) {
          clearTimeout(timeout);
          resolve();
        }
      });
      // Initialize to prime the server
      server.stdin!.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 0,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test', version: '0.1.0' },
          },
        }) + '\n'
      );
    });
  });

  afterAll(() => {
    server.kill();
    server.stdin?.destroy();
    server.stdout?.destroy();
    server.stderr?.destroy();
  });

  // ── Instructions ────────────────────────────────────────────────────────────

  describe('instructions', () => {
    it('includes compact syntax reference in initialize response', async () => {
      const initReq = {
        jsonrpc: '2.0',
        id: 99,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '0.1.0' },
        },
      };

      const response = await new Promise<JsonRpcMessage>((resolve, reject) => {
        let data = '';
        server.stdout!.on('data', (chunk: Buffer) => {
          data += chunk.toString();
          try {
            const lines = data.split('\n');
            for (const line of lines) {
              if (line.includes('"id":99')) {
                resolve(JSON.parse(line));
              }
            }
          } catch (e) {
            reject(e);
          }
        });
        server.stdin!.write(JSON.stringify(initReq) + '\n');
        setTimeout(() => reject(new Error('timeout')), 5000);
      });

      expect(response.result).toBeDefined();
      const result = response.result as Record<string, unknown>;
      expect(result.instructions).toBeDefined();
      const instructions = result.instructions as string;

      // Key elements the instructions must contain
      expect(instructions).toContain('# machine Name');
      expect(instructions).toContain('[initial]');
      expect(instructions).toContain('## transitions');
      expect(instructions).toContain('## actions');
      expect(instructions).toContain('| Source | Event | Guard | Target | Action |');
      expect(instructions).toContain('Minimal machine');
      expect(instructions).toContain('generate_machine');
      expect(instructions).toContain('verify_machine');
      expect(instructions).toContain('compile_machine');
      expect(instructions).toContain('Multi-machine');
    });

    it('instructions are under 400 tokens', async () => {
      const initReq = {
        jsonrpc: '2.0',
        id: 98,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '0.1.0' },
        },
      };

      const response = await new Promise<JsonRpcMessage>((resolve, reject) => {
        let data = '';
        server.stdout!.on('data', (chunk: Buffer) => {
          data += chunk.toString();
          try {
            const lines = data.split('\n');
            for (const line of lines) {
              if (line.includes('"id":98')) {
                resolve(JSON.parse(line));
              }
            }
          } catch (e) {
            reject(e);
          }
        });
        server.stdin!.write(JSON.stringify(initReq) + '\n');
        setTimeout(() => reject(new Error('timeout')), 5000);
      });

      const result = response.result as Record<string, unknown>;
      const instructions = result.instructions as string;
      // Rough token count: split on whitespace, filter empty
      const tokenCount = instructions.split(/\s+/).filter(Boolean).length;
      expect(tokenCount).toBeLessThan(400);
    });
  });

  // ── Resources ──────────────────────────────────────────────────────────────

  describe('resources capability', () => {
    it('advertises resources capability in initialize', async () => {
      const initReq = {
        jsonrpc: '2.0',
        id: 97,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '0.1.0' },
        },
      };

      const response = await new Promise<JsonRpcMessage>((resolve, reject) => {
        let data = '';
        server.stdout!.on('data', (chunk: Buffer) => {
          data += chunk.toString();
          try {
            const lines = data.split('\n');
            for (const line of lines) {
              if (line.includes('"id":97')) {
                resolve(JSON.parse(line));
              }
            }
          } catch (e) {
            reject(e);
          }
        });
        server.stdin!.write(JSON.stringify(initReq) + '\n');
        setTimeout(() => reject(new Error('timeout')), 5000);
      });

      const result = response.result as Record<string, unknown>;
      const capabilities = result.capabilities as Record<string, unknown>;
      expect(capabilities.resources).toBeDefined();
    });

    it('lists 3 resources: grammar and 2 examples', async () => {
      const listReq = {
        jsonrpc: '2.0',
        id: 2,
        method: 'resources/list',
        params: {},
      };

      const response = await new Promise<JsonRpcMessage>((resolve, reject) => {
        let data = '';
        server.stdout!.on('data', (chunk: Buffer) => {
          data += chunk.toString();
          try {
            const lines = data.split('\n');
            for (const line of lines) {
              if (line.includes('"id":2')) {
                resolve(JSON.parse(line));
              }
            }
          } catch (e) {
            reject(e);
          }
        });
        server.stdin!.write(JSON.stringify(listReq) + '\n');
        setTimeout(() => reject(new Error('timeout')), 5000);
      });

      const result = response.result as { resources: Array<{ uri: string; name: string }> };
      expect(result.resources).toHaveLength(3);

      const uris = result.resources.map((r) => r.uri);
      expect(uris).toContain('orca://grammar');
      expect(uris).toContain('orca://examples/simple-toggle');
      expect(uris).toContain('orca://examples/payment-processor');
    });

    it('grammar resource returns full grammar spec', async () => {
      const readReq = {
        jsonrpc: '2.0',
        id: 3,
        method: 'resources/read',
        params: { uri: 'orca://grammar' },
      };

      const response = await new Promise<JsonRpcMessage>((resolve, reject) => {
        let data = '';
        server.stdout!.on('data', (chunk: Buffer) => {
          data += chunk.toString();
          try {
            const lines = data.split('\n');
            for (const line of lines) {
              if (line.includes('"id":3')) {
                resolve(JSON.parse(line));
              }
            }
          } catch (e) {
            reject(e);
          }
        });
        server.stdin!.write(JSON.stringify(readReq) + '\n');
        setTimeout(() => reject(new Error('timeout')), 5000);
      });

      const result = response.result as { contents: Array<{ text: string }> };
      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].text).toContain('# Orca Markdown Grammar Specification');
      expect(result.contents[0].text).toContain('## transitions');
      expect(result.contents[0].text).toContain('## guards');
      expect(result.contents[0].text).toContain('## actions');
      expect(result.contents[0].mimeType).toBe('text/markdown');
    });

    it('simple-toggle example returns valid machine source', async () => {
      const readReq = {
        jsonrpc: '2.0',
        id: 4,
        method: 'resources/read',
        params: { uri: 'orca://examples/simple-toggle' },
      };

      const response = await new Promise<JsonRpcMessage>((resolve, reject) => {
        let data = '';
        server.stdout!.on('data', (chunk: Buffer) => {
          data += chunk.toString();
          try {
            const lines = data.split('\n');
            for (const line of lines) {
              if (line.includes('"id":4')) {
                resolve(JSON.parse(line));
              }
            }
          } catch (e) {
            reject(e);
          }
        });
        server.stdin!.write(JSON.stringify(readReq) + '\n');
        setTimeout(() => reject(new Error('timeout')), 5000);
      });

      const result = response.result as { contents: Array<{ text: string }> };
      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].text).toContain('# machine SimpleToggle');
      expect(result.contents[0].text).toContain('## state off [initial]');
      expect(result.contents[0].text).toContain('## transitions');
      expect(result.contents[0].mimeType).toBe('text/markdown');
    });

    it('payment-processor example returns valid machine source', async () => {
      const readReq = {
        jsonrpc: '2.0',
        id: 5,
        method: 'resources/read',
        params: { uri: 'orca://examples/payment-processor' },
      };

      const response = await new Promise<JsonRpcMessage>((resolve, reject) => {
        let data = '';
        server.stdout!.on('data', (chunk: Buffer) => {
          data += chunk.toString();
          try {
            const lines = data.split('\n');
            for (const line of lines) {
              if (line.includes('"id":5')) {
                resolve(JSON.parse(line));
              }
            }
          } catch (e) {
            reject(e);
          }
        });
        server.stdin!.write(JSON.stringify(readReq) + '\n');
        setTimeout(() => reject(new Error('timeout')), 5000);
      });

      const result = response.result as { contents: Array<{ text: string }> };
      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].text).toContain('# machine PaymentProcessor');
      expect(result.contents[0].text).toContain('## transitions');
      expect(result.contents[0].mimeType).toBe('text/markdown');
    });

    it('returns not found for unknown resource URI', async () => {
      const readReq = {
        jsonrpc: '2.0',
        id: 6,
        method: 'resources/read',
        params: { uri: 'orca://unknown/resource' },
      };

      const response = await new Promise<JsonRpcMessage>((resolve, reject) => {
        let data = '';
        server.stdout!.on('data', (chunk: Buffer) => {
          data += chunk.toString();
          try {
            const lines = data.split('\n');
            for (const line of lines) {
              if (line.includes('"id":6')) {
                resolve(JSON.parse(line));
              }
            }
          } catch (e) {
            reject(e);
          }
        });
        server.stdin!.write(JSON.stringify(readReq) + '\n');
        setTimeout(() => reject(new Error('timeout')), 5000);
      });

      const result = response.result as { contents: Array<{ text: string }> };
      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].text).toContain('not found');
    });
  });

  // ── Tool descriptions ───────────────────────────────────────────────────────

  describe('tools', () => {
    it('tools/list returns all 8 tools with enriched descriptions', async () => {
      const listReq = {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/list',
        params: {},
      };

      const response = await new Promise<JsonRpcMessage>((resolve, reject) => {
        let data = '';
        server.stdout!.on('data', (chunk: Buffer) => {
          data += chunk.toString();
          try {
            const lines = data.split('\n');
            for (const line of lines) {
              if (line.includes('"id":7')) {
                resolve(JSON.parse(line));
              }
            }
          } catch (e) {
            reject(e);
          }
        });
        server.stdin!.write(JSON.stringify(listReq) + '\n');
        setTimeout(() => reject(new Error('timeout')), 5000);
      });

      const result = response.result as { tools: Array<{ name: string; description: string }> };
      expect(result.tools).toHaveLength(12);

      const tools = result.tools.reduce<Record<string, string>>(
        (acc, t) => ({ ...acc, [t.name]: t.description }),
        {}
      );

      // Verify enriched descriptions
      expect(tools.parse_machine).toContain('[initial|final]');
      expect(tools.parse_machine).toContain('| Source | Event | Guard | Target | Action |');

      expect(tools.verify_machine).toContain('[initial] presence');
      expect(tools.verify_machine).toContain('reachability');
      expect(tools.verify_machine).toContain('guard determinism');
      expect(tools.verify_machine).toContain('Run before compile_machine');

      expect(tools.generate_machine).toContain('draft .orca.md');
      expect(tools.generate_machine).toContain('natural language spec');
      expect(tools.generate_machine).toContain('verify_machine');

      expect(tools.generate_actions).toContain('lang: typescript');
      expect(tools.generate_actions).toContain('python');
      expect(tools.generate_actions).toContain('go');
      expect(tools.generate_actions).toContain('verified .orca.md source');

      expect(tools.refine_machine).toContain('verify_machine errors');
      expect(tools.refine_machine).toContain('max_iterations');
    });

    it('verify_machine tool works end-to-end', async () => {
      const callReq = {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: {
          name: 'verify_machine',
          arguments: {
            source:
              '# machine Toggle\n\n## state off [initial]\n## state on\n\n## transitions\n| off | toggle | | on | |\n| on  | toggle | | off | |\n',
          },
        },
      };

      const response = await new Promise<JsonRpcMessage>((resolve, reject) => {
        let data = '';
        server.stdout!.on('data', (chunk: Buffer) => {
          data += chunk.toString();
          try {
            const lines = data.split('\n');
            for (const line of lines) {
              if (line.includes('"id":8')) {
                resolve(JSON.parse(line));
              }
            }
          } catch (e) {
            reject(e);
          }
        });
        server.stdin!.write(JSON.stringify(callReq) + '\n');
        setTimeout(() => reject(new Error('timeout')), 5000);
      });

      const result = response.result as { content: Array<{ text: string }> };
      const text = result.content[0].text;
      expect(text).toContain('status');
      expect(text).toContain('DEADLOCK');
    });
  });
});
