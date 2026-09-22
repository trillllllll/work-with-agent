import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mountMcp } from './mcp/http.js';

describe('stdio MCP authenticated HTTP contract', () => {
  let http: Server;
  let client: Client;
  const calls: Array<{ url: string; authorization: string | undefined; body: any }> = [];
  beforeAll(async () => {
    http = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      calls.push({ url: req.url!, authorization: req.headers.authorization, body });
      res.setHeader('Content-Type', 'application/json');
      if (req.url!.includes('/tasks/missing')) { res.statusCode = 409; res.end(JSON.stringify({ data: null, code: 'VERSION_CONFLICT', error: 'Task changed' })); return; }
      res.end(JSON.stringify({ data: body ? { status: 'pending_approval', proposalId: 'proposal-1' } : { items: [{ id: 'task-1', revision: 3 }], nextCursor: 'cursor-2', hasMore: true }, error: null }));
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const address = http.address() as { port: number };
    client = new Client({ name: 'contract-test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', fileURLToPath(new URL('./mcp/index.ts', import.meta.url))], env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), WWA_API_URL: `http://127.0.0.1:${address.port}`, WWA_CONNECTION_TOKEN: 'isolated-test-connection' }, stderr: 'pipe' }));
  }, 20_000);
  afterAll(async () => { await client?.close(); if (http) await new Promise<void>((resolve) => http.close(() => resolve())); });
  it('advertises Todo, knowledge, proposals and handoff tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['list_tasks', 'submit_commands', 'get_proposal', 'get_material', 'claim_handoff', 'report_run']));
  });
  it('preserves pagination and authenticated connection identity', async () => {
    const result = await client.callTool({ name: 'list_tasks', arguments: { topicId: 'scope-1', inbox: false, cursor: 'cursor-1', limit: 2 } });
    expect(result.structuredContent).toMatchObject({ data: { nextCursor: 'cursor-2', hasMore: true }, httpStatus: 200 });
    expect(calls.at(-1)).toMatchObject({ authorization: 'Bearer isolated-test-connection' });
    expect(calls.at(-1)?.url).toContain('inbox=false');
  });
  it('does not erase false, null, empty sets or request IDs, and distinguishes a proposal', async () => {
    const body = { requestId: 'same-logical-request', commands: [{ kind: 'task.update', targetId: 'task-1', expectedRevision: 3, input: { dueDate: null, tagIds: [], completeChildren: false, description: '' } }] };
    const result = await client.callTool({ name: 'submit_commands', arguments: body });
    expect(calls.at(-1)?.body).toEqual(body);
    expect(result.structuredContent).toMatchObject({ data: { status: 'pending_approval', proposalId: 'proposal-1' } });
  });
  it('preserves business conflict codes instead of reporting success', async () => {
    const result = await client.callTool({ name: 'get_task', arguments: { taskId: 'missing' } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: 'VERSION_CONFLICT', httpStatus: 409, retryable: false });
  });
});

describe('MCP is served by the workspace process', () => {
  let api: Server;
  let workspace: Server;
  let client: Client;
  const previousApi = process.env.WWA_API_URL;
  const calls: Array<{ authorization: string | undefined }> = [];
  beforeAll(async () => {
    api = createServer((req, res) => {
      calls.push({ authorization: req.headers.authorization });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: { items: [{ id: 'task-1' }], nextCursor: null, hasMore: false }, error: null }));
    });
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
    process.env.WWA_API_URL = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
    const app = express();
    app.use(express.json());
    mountMcp(app, async (token) => token === 'isolated-test-connection');
    workspace = createServer(app);
    await new Promise<void>((resolve) => workspace.listen(0, '127.0.0.1', resolve));
    client = new Client({ name: 'workspace-mcp', version: '1.0.0' });
    const port = (workspace.address() as { port: number }).port;
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: 'Bearer isolated-test-connection' } } }));
  }, 20_000);
  afterAll(async () => {
    if (previousApi === undefined) delete process.env.WWA_API_URL;
    else process.env.WWA_API_URL = previousApi;
    await client?.close();
    await Promise.all([api, workspace].filter(Boolean).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });
  it('rejects a missing credential and serves tools on the workspace port', async () => {
    const port = (workspace.address() as { port: number }).port;
    const denied = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
    expect(denied.status).toBe(401);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain('list_tasks');
    await client.callTool({ name: 'list_tasks', arguments: { limit: 1 } });
    expect(calls.at(-1)?.authorization).toBe('Bearer isolated-test-connection');
  });
});
