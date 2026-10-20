import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mountMcp } from './mcp/http.js';
import { descriptionImageRefs, shouldAttachTaskImage, taskDetailImageRefs, taskImageAttachCount, taskImageAttachPerImage, taskImageAttachTotal } from './mcp/task-image-content.js';

describe('stdio MCP authenticated HTTP contract', () => {
  let http: Server;
  let client: Client;
  const calls: Array<{ url: string; authorization: string | undefined; loopback: string | string[] | undefined; body: any }> = [];
  beforeAll(async () => {
    http = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      calls.push({ url: req.url!, authorization: req.headers.authorization, loopback: req.headers['x-wwa-loopback'], body });
      if (req.url === '/api/v1/tasks/task-image') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: { id: 'task-image', description: '说明\n![示意图](/api/tasks/task-image/images/image-a)\n![太大](/api/tasks/task-image/images/image-big)\n![](/api/tasks/other/images/image-x)\n', children: [{ id: 'child-1', description: '![](/api/tasks/child-1/images/image-c)' }] }, error: null }));
        return;
      }
      if (req.url!.includes('/images/missing')) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: null, code: 'NOT_FOUND', error: '图片不存在' }));
        return;
      }
      if (req.url!.includes('/images/')) {
        const bytes = req.url!.includes('image-big') ? Buffer.alloc(taskImageAttachPerImage + 1, 7) : Buffer.from(req.url!.includes('image-c') ? 'webp-bytes' : 'jpeg-bytes');
        res.setHeader('Content-Type', req.url!.includes('image-c') ? 'image/webp' : 'image/jpeg');
        res.setHeader('Content-Length', String(bytes.length));
        res.end(bytes);
        return;
      }
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
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['list_tasks', 'get_task', 'get_task_image', 'submit_commands', 'get_proposal', 'get_material', 'list_library_folders', 'list_library_tags', 'claim_handoff', 'report_run']));
  });
  it('lists library folders and tags through the existing reads', async () => {
    await client.callTool({ name: 'list_library_folders', arguments: {} });
    expect(calls.at(-1)?.url).toBe('/api/v1/library/folders');
    await client.callTool({ name: 'list_library_tags', arguments: {} });
    expect(calls.at(-1)?.url).toBe('/api/v1/library/tags');
    expect(calls.at(-1)?.authorization).toBe('Bearer isolated-test-connection');
  });
  it('preserves pagination and authenticated connection identity', async () => {
    const result = await client.callTool({ name: 'list_tasks', arguments: { topicId: 'scope-1', inbox: false, cursor: 'cursor-1', limit: 2, scheduledFrom: '2026-10-12', scheduledTo: '2026-10-12' } });
    expect(result.structuredContent).toMatchObject({ data: { nextCursor: 'cursor-2', hasMore: true }, httpStatus: 200 });
    expect(calls.at(-1)).toMatchObject({ authorization: 'Bearer isolated-test-connection' });
    expect(calls.at(-1)?.loopback).toEqual(expect.any(String));
    expect(calls.at(-1)?.url).toContain('inbox=false');
    expect(calls.at(-1)?.url).toContain('scheduledFrom=2026-10-12');
    expect(calls.at(-1)?.url).toContain('scheduledTo=2026-10-12');
  });
  it('does not erase false, null, empty sets or request IDs, and distinguishes a proposal', async () => {
    const body = { requestId: 'same-logical-request', commands: [{ kind: 'task.update', targetId: 'task-1', expectedRevision: 3, input: { dueDate: null, tagIds: [], completeChildren: false, description: '' } }] };
    const result = await client.callTool({ name: 'submit_commands', arguments: body });
    expect(calls.at(-1)?.body).toEqual(body);
    expect(result.structuredContent).toMatchObject({ data: { status: 'pending_approval', proposalId: 'proposal-1' } });
  });
  it('preserves business conflict codes instead of reporting success', async () => {
    const start = calls.length;
    const result = await client.callTool({ name: 'get_task', arguments: { taskId: 'missing' } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: 'VERSION_CONFLICT', httpStatus: 409, retryable: false });
    expect(calls.slice(start).map((call) => call.url)).toEqual(['/api/v1/tasks/missing']);
  });
  it('reads this task screenshots and skips bytes that are not images', async () => {
    const start = calls.length;
    const result = await client.callTool({ name: 'get_task', arguments: { taskId: 'task-image' } });
    const fresh = calls.slice(start).map((call) => call.url);
    expect(fresh).toEqual([
      '/api/v1/tasks/task-image',
      '/api/v1/tasks/task-image/images/image-a',
      '/api/v1/tasks/task-image/images/image-big',
    ]);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ data: { description: expect.stringContaining('/api/tasks/task-image/images/image-a') }, httpStatus: 200 });
    expect(JSON.stringify(result.structuredContent)).not.toContain(Buffer.from('jpeg-bytes').toString('base64'));
    const blocks = result.content as Array<{ type: string; text?: string }>;
    expect(blocks.filter((block) => block.type === 'image')).toHaveLength(0);
    const summary = blocks.at(-1)?.text ?? '';
    expect(summary).toContain('imageId=image-a');
    expect(summary).toContain('imageId=image-big');
    expect(summary).toContain('get_task_image');
    expect(summary).not.toContain('image-c');
    expect(summary).not.toContain('image-x');
    const one = await client.callTool({ name: 'get_task_image', arguments: { taskId: 'task-image', imageId: 'image-a' } });
    expect(one.isError).toBe(true);
    expect(one.structuredContent).toMatchObject({ code: 'IMAGE_UNAVAILABLE', retryable: false });
    const missing = await client.callTool({ name: 'get_task_image', arguments: { taskId: 'task-image', imageId: 'missing' } });
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent).toMatchObject({ code: 'NOT_FOUND', httpStatus: 404, retryable: false });
  });
  it('does not fetch images when the task description has none', async () => {
    const start = calls.length;
    await client.callTool({ name: 'get_task', arguments: { taskId: 'task-1' } });
    expect(calls.slice(start).map((call) => call.url)).toEqual(['/api/v1/tasks/task-1']);
  });
});

describe('task detail image selection', () => {
  it('keeps only this task images, in order, with alt text', () => {
    const description = '前文 ![示意图](/api/tasks/task-a/images/image-a) 重复 ![示意图](/api/tasks/task-a/images/image-a) ![](/api/tasks/other/images/image-x)';
    expect(descriptionImageRefs('task-a', description)).toEqual([{ taskId: 'task-a', imageId: 'image-a', alt: '示意图' }]);
    expect(taskDetailImageRefs({ id: 'task-a', description, children: [{ id: 'child-1', description: '![](/api/tasks/child-1/images/image-c)' }] })).toEqual([
      { taskId: 'task-a', imageId: 'image-a', alt: '示意图' },
      { taskId: 'child-1', imageId: 'image-c', alt: '' },
    ]);
  });
  it('stops attaching after the count, per-image, or total budget', () => {
    expect(shouldAttachTaskImage(taskImageAttachCount, 1, 0)).toBe(false);
    expect(shouldAttachTaskImage(0, taskImageAttachPerImage + 1, 0)).toBe(false);
    expect(shouldAttachTaskImage(1, taskImageAttachPerImage, taskImageAttachPerImage)).toBe(true);
    expect(shouldAttachTaskImage(2, 1, taskImageAttachTotal)).toBe(false);
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

describe('MCP task images and material attachments', () => {
  let http: Server;
  let client: Client;
  const calls: Array<{ url: string; authorization: string | undefined }> = [];
  let png: Buffer;
  beforeAll(async () => {
    const sharp = (await import('sharp')).default;
    png = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 20, g: 40, b: 60 } } }).png().toBuffer();
    const served = new Set(['img-1', 'img-2', 'img-3', 'img-4', 'img-5']);
    http = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      calls.push({ url: `${url.pathname}${url.search}`, authorization: req.headers.authorization });
      const imageMatch = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/images\/([^/]+)$/);
      if (imageMatch) {
        const imageId = decodeURIComponent(imageMatch[2]);
        if (!served.has(imageId)) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ data: null, error: '图片不存在', code: 'NOT_FOUND' }));
          return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Content-Length', String(png.byteLength));
        res.end(png);
        return;
      }
      const attachment = url.pathname.match(/^\/api\/v1\/knowledge\/materials\/([^/]+)\/versions\/([^/]+)\/attachment$/);
      if (attachment) {
        const materialId = decodeURIComponent(attachment[1]);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (materialId === 'mat-text') {
          const body = Buffer.from('# hello notes');
          res.setHeader('X-WWA-Mime-Type', 'text/markdown');
          res.setHeader('Content-Disposition', `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent('notes.md')}`);
          res.end(body);
          return;
        }
        res.setHeader('X-WWA-Mime-Type', 'image/png');
        res.setHeader('Content-Disposition', `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent('shot.png')}`);
        res.end(png);
        return;
      }
      if (url.pathname === '/api/v1/tasks/task-1') {
        const description = [
          '![a](/api/tasks/task-1/images/img-1)',
          '![b](http://127.0.0.1:3016/api/tasks/task-1/images/img-2)',
          '![c](/api/tasks/task-1/images/img-3)',
          '![d](/api/tasks/task-1/images/img-4)',
          '![e](/api/tasks/task-1/images/img-5)',
          '![missing](/api/tasks/task-1/images/img-missing)',
          '![extra](/api/tasks/task-1/images/img-7)',
          '![other](/api/tasks/other-task/images/img-secret)',
          '![dup](/api/tasks/task-1/images/img-1)',
        ].join('\n');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: { id: 'task-1', description, revision: 3 }, error: null }));
        return;
      }
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: null, error: 'not found', code: 'NOT_FOUND' }));
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const address = http.address() as { port: number };
    client = new Client({ name: 'media-contract', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', fileURLToPath(new URL('./mcp/index.ts', import.meta.url))], env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), WWA_API_URL: `http://127.0.0.1:${address.port}`, WWA_CONNECTION_TOKEN: 'isolated-test-connection' }, stderr: 'pipe' }));
  }, 30_000);
  afterAll(async () => { await client?.close(); if (http) await new Promise<void>((resolve) => http.close(() => resolve())); });

  it('returns the original JSON first, then image blocks, and summarizes skips past the cap', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['get_task_image', 'get_material_attachment']));
    expect(JSON.stringify(tools.find((tool) => tool.name === 'get_task')?.inputSchema)).toContain('includeImages');
    const before = calls.length;
    const result = await client.callTool({ name: 'get_task', arguments: { taskId: 'task-1' } });
    const content = result.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    expect(result.isError).not.toBe(true);
    expect(content[0]?.type).toBe('text');
    const payload = JSON.parse(content[0].text ?? '');
    expect(payload).toMatchObject({ data: { id: 'task-1', revision: 3 }, httpStatus: 200 });
    expect(result.structuredContent).toEqual(payload);
    expect(JSON.stringify(result.structuredContent)).not.toContain(png.toString('base64'));
    const images = content.filter((block) => block.type === 'image');
    expect(images).toHaveLength(5);
    expect(images.every((block) => block.mimeType === 'image/png' && block.data === png.toString('base64'))).toBe(true);
    for (let index = 0; index < 5; index += 1) {
      const caption = content[1 + index * 2];
      expect(caption?.type).toBe('text');
      expect(caption?.text).toContain(`Image ${index + 1}/5`);
      expect(caption?.text).toContain(`imageId=img-${index + 1}`);
      expect(caption?.text).toContain(`/api/tasks/task-1/images/img-${index + 1}`);
      expect(content[2 + index * 2]?.type).toBe('image');
    }
    const summary = content.at(-1);
    expect(summary?.type).toBe('text');
    expect(summary?.text).toContain('imageId=img-missing');
    expect(summary?.text).toContain('HTTP 404');
    expect(summary?.text).toContain('imageId=img-7');
    expect(summary?.text).toContain('count cap');
    expect(summary?.text).toContain('get_task_image');
    expect(summary?.text).not.toContain('img-secret');
    const imageCalls = calls.slice(before).map((call) => call.url);
    expect(imageCalls.some((url) => url.includes('/images/img-1'))).toBe(true);
    expect(imageCalls.some((url) => url.includes('/images/img-7'))).toBe(false);
    expect(imageCalls.some((url) => url.includes('img-secret'))).toBe(false);
    expect(calls.slice(before).every((call) => call.authorization === 'Bearer isolated-test-connection')).toBe(true);
  });

  it('returns only the original content when includeImages is false', async () => {
    const before = calls.length;
    const result = await client.callTool({ name: 'get_task', arguments: { taskId: 'task-1', includeImages: false } });
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(1);
    expect(content[0]?.type).toBe('text');
    expect(JSON.parse(content[0].text ?? '')).toMatchObject({ data: { id: 'task-1' }, httpStatus: 200 });
    expect(result.structuredContent).toEqual(JSON.parse(content[0].text ?? ''));
    expect(calls.slice(before).some((call) => call.url.includes('/images/'))).toBe(false);
  });

  it('reports get_task_image failures as a JSON error block', async () => {
    const result = await client.callTool({ name: 'get_task_image', arguments: { taskId: 'task-1', imageId: 'missing' } });
    expect(result.isError).toBe(true);
    const errorText = (result.content as Array<{ text: string }>)[0]?.text ?? '';
    const body = JSON.parse(errorText);
    expect(body).toMatchObject({ code: 'NOT_FOUND', message: '图片不存在', httpStatus: 404, retryable: false });
    expect(result.structuredContent).toMatchObject({ code: 'NOT_FOUND', httpStatus: 404, retryable: false });
  });

  it('returns text and image material attachments', async () => {
    const textResult = await client.callTool({ name: 'get_material_attachment', arguments: { materialId: 'mat-text', revision: 1 } });
    expect(textResult.isError).not.toBe(true);
    const textBlocks = textResult.content as Array<{ type: string; text?: string; resource?: { uri: string; mimeType: string; text?: string } }>;
    expect(textBlocks[0]).toMatchObject({ type: 'text' });
    expect(textBlocks[0].text).toContain('materialId=mat-text');
    expect(textBlocks[0].text).toContain('revision=1');
    expect(textBlocks[0].text).toContain('fileName=notes.md');
    expect(textBlocks[0].text).toContain('mimeType=text/markdown');
    expect(textBlocks[1]).toMatchObject({ type: 'resource', resource: { uri: 'wwa://materials/mat-text/versions/1/attachment', mimeType: 'text/markdown', text: '# hello notes' } });
    expect(calls.at(-1)?.url).toBe('/api/v1/knowledge/materials/mat-text/versions/1/attachment');

    const imageResult = await client.callTool({ name: 'get_material_attachment', arguments: { materialId: 'mat-image', revision: 2 } });
    const imageBlocks = imageResult.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    expect(imageResult.isError).not.toBe(true);
    expect(imageBlocks[0].text).toContain('materialId=mat-image');
    expect(imageBlocks[0].text).toContain('revision=2');
    expect(imageBlocks[0].text).toContain('fileName=shot.png');
    expect(imageBlocks[0].text).toContain('mimeType=image/png');
    expect(imageBlocks[0].text).toContain(`byteSize=${png.byteLength}`);
    expect(imageBlocks[1]).toMatchObject({ type: 'image', mimeType: 'image/png', data: png.toString('base64') });
    expect(calls.at(-1)?.url).toBe('/api/v1/knowledge/materials/mat-image/versions/2/attachment');
  });
});
