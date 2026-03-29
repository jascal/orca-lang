import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseMarkdown } from '../src/parser/markdown-parser.js';
import { machineToMarkdown } from '../src/parser/ast-to-markdown.js';
import { checkStructural, analyzeFile } from '../src/verifier/structural.js';
import { checkCompleteness } from '../src/verifier/completeness.js';
import { compileToMermaid } from '../src/compiler/mermaid.js';

const SOURCE = readFileSync(join(__dirname, '../examples/key-exchange.orca.md'), 'utf-8');

describe('key-exchange example: parsing', () => {
  it('parses all three machines from the file', () => {
    const { file } = parseMarkdown(SOURCE);
    expect(file.machines).toHaveLength(3);
    expect(file.machines.map(m => m.name)).toEqual([
      'KeyExchangeCoordinator',
      'KeyExchangeClient',
      'KeyExchangeServer',
    ]);
  });

  it('KeyExchangeCoordinator has correct states and events', () => {
    const { file } = parseMarkdown(SOURCE);
    const coordinator = file.machines[0];
    const stateNames = coordinator.states.map(s => s.name);
    expect(stateNames).toContain('idle');
    expect(stateNames).toContain('coordinating');
    expect(stateNames).toContain('done');
    expect(stateNames).toContain('failed');
    expect(coordinator.states.find(s => s.isInitial)?.name).toBe('idle');
    expect(coordinator.states.filter(s => s.isFinal).map(s => s.name)).toEqual(['done', 'failed']);
    expect(coordinator.events.map((e: any) => e.name)).toContain('start_exchange');
  });

  it('KeyExchangeClient has correct states and events', () => {
    const { file } = parseMarkdown(SOURCE);
    const client = file.machines[1];
    const stateNames = client.states.map(s => s.name);
    expect(stateNames).toContain('idle');
    expect(stateNames).toContain('waiting_server_key');
    expect(stateNames).toContain('sending_client_key');
    expect(stateNames).toContain('waiting_final_ack');
    expect(stateNames).toContain('established');
    expect(stateNames).toContain('error_state');
    expect(client.states.find(s => s.isInitial)?.name).toBe('idle');
    expect(client.states.filter(s => s.isFinal).map(s => s.name)).toEqual(['established', 'error_state']);
    expect(client.events.map((e: any) => e.name)).toEqual(['start', 'server_hello_ack', 'client_key_sent', 'ack_received', 'error']);
  });

  it('KeyExchangeServer has correct states and events', () => {
    const { file } = parseMarkdown(SOURCE);
    const server = file.machines[2];
    const stateNames = server.states.map(s => s.name);
    expect(stateNames).toContain('listening');
    expect(stateNames).toContain('waiting_client_key');
    expect(stateNames).toContain('sending_ack');
    expect(stateNames).toContain('established');
    expect(stateNames).toContain('error_state');
    expect(server.states.find(s => s.isInitial)?.name).toBe('listening');
    expect(server.states.filter(s => s.isFinal).map(s => s.name)).toEqual(['established', 'error_state']);
  });

  it('coordinator invokes KeyExchangeClient', () => {
    const { file } = parseMarkdown(SOURCE);
    const coordinator = file.machines[0];
    const coordinating = coordinator.states.find(s => s.name === 'coordinating');
    expect(coordinating?.invoke?.machine).toBe('KeyExchangeClient');
  });

  it('client states have on_entry actions', () => {
    const { file } = parseMarkdown(SOURCE);
    const client = file.machines[1];
    expect(client.states.find(s => s.name === 'waiting_server_key')?.onEntry).toBe('send_hello');
    expect(client.states.find(s => s.name === 'sending_client_key')?.onEntry).toBe('send_encrypted_key');
  });

  it('server states have on_entry actions', () => {
    const { file } = parseMarkdown(SOURCE);
    const server = file.machines[2];
    expect(server.states.find(s => s.name === 'waiting_client_key')?.onEntry).toBe('send_public_key');
    expect(server.states.find(s => s.name === 'sending_ack')?.onEntry).toBe('send_ack');
  });
});

describe('key-exchange example: verification', () => {
  it('KeyExchangeCoordinator passes structural verification', () => {
    const { file } = parseMarkdown(SOURCE);
    const result = checkStructural(file.machines[0]);
    expect(result.valid).toBe(true);
    expect(result.errors.filter(e => e.severity === 'error')).toHaveLength(0);
  });

  it('KeyExchangeClient passes structural verification', () => {
    const { file } = parseMarkdown(SOURCE);
    const result = checkStructural(file.machines[1]);
    expect(result.valid).toBe(true);
    expect(result.errors.filter(e => e.severity === 'error')).toHaveLength(0);
  });

  it('KeyExchangeServer passes structural verification', () => {
    const { file } = parseMarkdown(SOURCE);
    const result = checkStructural(file.machines[2]);
    expect(result.valid).toBe(true);
    expect(result.errors.filter(e => e.severity === 'error')).toHaveLength(0);
  });

  it('KeyExchangeClient passes completeness check', () => {
    const { file } = parseMarkdown(SOURCE);
    const result = checkCompleteness(file.machines[1]);
    expect(result.errors.filter((e: any) => e.severity === 'error')).toHaveLength(0);
  });

  it('KeyExchangeServer passes completeness check', () => {
    const { file } = parseMarkdown(SOURCE);
    const result = checkCompleteness(file.machines[2]);
    expect(result.errors.filter((e: any) => e.severity === 'error')).toHaveLength(0);
  });

  it('cross-machine analysis resolves invocation and finds no errors', () => {
    const { file } = parseMarkdown(SOURCE);
    const result = analyzeFile(file);
    expect(result.errors.filter(e => e.severity === 'error')).toHaveLength(0);
  });
});

describe('key-exchange example: compilation', () => {
  it('KeyExchangeClient compiles to Mermaid with all states', () => {
    const { file } = parseMarkdown(SOURCE);
    const output = compileToMermaid(file.machines[1]);
    expect(output).toContain('stateDiagram-v2');
    expect(output).toContain('idle');
    expect(output).toContain('waiting_server_key');
    expect(output).toContain('sending_client_key');
    expect(output).toContain('waiting_final_ack');
    expect(output).toContain('established');
    expect(output).toContain('error_state');
  });

  it('KeyExchangeClient Mermaid output contains happy-path transitions', () => {
    const { file } = parseMarkdown(SOURCE);
    const output = compileToMermaid(file.machines[1]);
    expect(output).toContain('idle --> waiting_server_key');
    expect(output).toContain('waiting_server_key --> sending_client_key');
    expect(output).toContain('sending_client_key --> waiting_final_ack');
    expect(output).toContain('waiting_final_ack --> established');
  });

  it('KeyExchangeServer compiles to Mermaid with all states', () => {
    const { file } = parseMarkdown(SOURCE);
    const output = compileToMermaid(file.machines[2]);
    expect(output).toContain('stateDiagram-v2');
    expect(output).toContain('listening');
    expect(output).toContain('waiting_client_key');
    expect(output).toContain('sending_ack');
    expect(output).toContain('established');
    expect(output).toContain('error_state');
  });

  it('KeyExchangeServer Mermaid output contains happy-path transitions', () => {
    const { file } = parseMarkdown(SOURCE);
    const output = compileToMermaid(file.machines[2]);
    expect(output).toContain('listening --> waiting_client_key');
    expect(output).toContain('waiting_client_key --> sending_ack');
    expect(output).toContain('sending_ack --> established');
  });

  it('error paths appear in both Client and Server Mermaid output', () => {
    const { file } = parseMarkdown(SOURCE);
    const clientOutput = compileToMermaid(file.machines[1]);
    const serverOutput = compileToMermaid(file.machines[2]);
    expect(clientOutput).toContain('error_state');
    expect(serverOutput).toContain('error_state');
  });
});

describe('key-exchange example: round-trip', () => {
  function stripTokens(machine: any): any {
    return JSON.parse(JSON.stringify(machine, (key, value) => {
      if (key === 'tokens') return undefined;
      return value;
    }));
  }

  it('KeyExchangeClient round-trips through ast-to-markdown', () => {
    const { file } = parseMarkdown(SOURCE);
    const client = file.machines[1];
    const md2 = machineToMarkdown(client);
    const reparsed = parseMarkdown(md2).file.machines[0];
    expect(stripTokens(reparsed)).toEqual(stripTokens(client));
  });

  it('KeyExchangeServer round-trips through ast-to-markdown', () => {
    const { file } = parseMarkdown(SOURCE);
    const server = file.machines[2];
    const md2 = machineToMarkdown(server);
    const reparsed = parseMarkdown(md2).file.machines[0];
    expect(stripTokens(reparsed)).toEqual(stripTokens(server));
  });
});
