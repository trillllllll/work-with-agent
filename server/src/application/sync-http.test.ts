import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import sharp from 'sharp';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = mkdtempSync(join(tmpdir(), 'dovun-sync-http-'));
type Peer = { child: ChildProcess; port: number; cookie: string; csrf: string; request: (path: string, body?: object, method?: string) => Promise<{ status: number; data: any; code?: string }> };
const children = new Set<ChildProcess>();

async function start(name: string, port = 0): Promise<Peer> {
  const data = join(directory, name);
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: `file:${join(data, 'test.db')}`, DOVUN_DATA_DIR: data, KNOWLEDGE_STORAGE_ROOT: join(data, 'blobs'), DOVUN_SERVER_MODE: '0', SYNC_TEST_PORT: String(port) };
  delete env.VITEST; delete env.DOVUN_SYNC_URL; delete env.DOVUN_SYNC_TOKEN; delete env.DOVUN_CONTAINER;
  const child = spawn(process.execPath, ['--import', 'tsx', 'test/fixtures/sync-process.ts'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  child.once('exit', () => children.delete(child));
  const ready = await new Promise<{ port: number; bootstrap: string }>((accept, reject) => {
    let output = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Sync fixture startup timed out')); }, 20_000);
    child.stdout!.on('data', chunk => {
      output += chunk.toString();
      for (const line of output.split('\n')) {
        try { const row = JSON.parse(line); if (row.port && row.bootstrap) { clearTimeout(timer); accept(row); } } catch { /* Ignore unrelated startup text. */ }
      }
    });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Sync fixture exited before startup')); });
    child.once('error', reject);
    // Consume stderr without exposing tokens or body contents in test output.
    child.stderr!.resume();
  });
  const url = `http://127.0.0.1:${ready.port}`;
  const login = await fetch(`${url}/api/v1/auth/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bootstrapToken: ready.bootstrap }) });
  expect(login.status).toBe(200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const csrf = (await login.json()).data.csrfToken;
  return { child, port: ready.port, cookie, csrf, request: async (path, body, method) => {
    const response = await fetch(url + path, { method: method ?? (body ? 'POST' : 'GET'), headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const payload = await response.json();
    return { status: response.status, data: payload.data, code: payload.code };
  } };
}
async function stop(peer: Peer) {
  if (peer.child.exitCode !== null) return;
  await new Promise<void>((accept, reject) => {
    const timer = setTimeout(() => { peer.child.kill('SIGKILL'); reject(new Error('Sync fixture did not stop')); }, 5_000);
    peer.child.once('exit', () => { clearTimeout(timer); children.delete(peer.child); accept(); });
    peer.child.kill('SIGTERM');
  });
}

describe('task sync across independent HTTP processes', () => {
  beforeAll(() => {
    for (const name of ['hub', 'local', 'hub-shared', 'local-shared']) {
      const data = join(directory, name); mkdirSync(data);
      writeFileSync(join(data, 'test.db'), '');
      execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], { cwd: root, env: { ...process.env, DATABASE_URL: `file:${join(data, 'test.db')}` }, stdio: 'pipe' });
    }
  }, 30_000);
  afterAll(async () => {
    for (const child of children) { if (child.exitCode !== null) continue; child.kill('SIGKILL'); await new Promise<void>(accept => child.once('exit', () => accept())); }
    rmSync(directory, { recursive: true, force: true });
  });

  it('keeps an offline edit through restart, automatically catches up, and resolves cloud conflicts locally', async () => {
    let hub = await start('hub');
    let local = await start('local');
    const cloudTask = await hub.request('/api/tasks', { title: '云端起始任务' });
    expect(cloudTask.status).toBe(200);
    const taskId = cloudTask.data.id;
    const pairing = await hub.request('/api/v1/sync/devices', { name: 'http-fixture' });
    const binding = { url: `http://127.0.0.1:${hub.port}`, token: pairing.data.token };
    // A rejected first credential must not leave an irreparable binding behind.
    expect(await local.request('/api/v1/sync/bind', { ...binding, token: 'invalid-token-that-is-long-enough' })).toMatchObject({ status: 502, code: 'SYNC_AUTH_FAILED' });
    expect(existsSync(join(directory, 'local', 'sync-device.json'))).toBe(false);
    expect((await local.request('/api/v1/sync/bind', binding)).status).toBe(200);
    expect((await local.request('/api/v1/sync/run', {})).status).toBe(200);
    expect((await local.request(`/api/tasks/${taskId}`)).data.title).toBe('云端起始任务');

    const hubPort = hub.port;
    await stop(hub);
    const before = (await local.request(`/api/tasks/${taskId}`)).data;
    expect((await local.request(`/api/tasks/${taskId}`, { description: '断网时的修改，重启后必须还在', expectedRevision: before.revision }, 'PATCH')).status).toBe(200);
    expect((await local.request('/api/v1/sync/run', {})).status).not.toBe(200);
    expect((await local.request('/api/v1/sync/status')).data.pending).toBeGreaterThan(0);
    await stop(local);
    local = await start('local');
    expect((await local.request(`/api/tasks/${taskId}`)).data.description).toBe('断网时的修改，重启后必须还在');
    expect((await local.request('/api/v1/sync/status')).data.pending).toBeGreaterThan(0);
    hub = await start('hub', hubPort);
    await expect.poll(async () => (await hub.request(`/api/tasks/${taskId}`)).data.description, { timeout: 12_000, interval: 200 }).toBe('断网时的修改，重启后必须还在');
    expect((await local.request('/api/v1/sync/status')).data.pending).toBe(0);

    const cloudBefore = (await hub.request(`/api/tasks/${taskId}`)).data;
    const localBefore = (await local.request(`/api/tasks/${taskId}`)).data;
    await stop(hub);
    expect((await local.request(`/api/tasks/${taskId}`, { title: '本机离线标题', expectedRevision: localBefore.revision }, 'PATCH')).status).toBe(200);
    hub = await start('hub', hubPort);
    expect((await hub.request(`/api/tasks/${taskId}`, { title: '云端独立标题', expectedRevision: cloudBefore.revision }, 'PATCH')).status).toBe(200);
    expect((await local.request('/api/v1/sync/run', {})).status).toBe(200);
    const conflicts = await local.request('/api/v1/sync/conflicts');
    const conflict = conflicts.data.find((item: any) => item.entityId === taskId && item.field === 'title');
    expect(conflict).toMatchObject({ incoming: '本机离线标题', live: '云端独立标题' });
    expect((await local.request(`/api/v1/sync/conflicts/${conflict.id}/resolve`, { choice: 'mine' })).status).toBe(200);
    await local.request('/api/v1/sync/run', {});
    expect((await local.request(`/api/tasks/${taskId}`)).data.title).toBe('本机离线标题');
    expect((await hub.request(`/api/tasks/${taskId}`)).data.title).toBe('本机离线标题');
    await stop(local); await stop(hub);
  }, 60_000);

  it('shares chat and downloaded files, retains MCP scopes and requires approval for remote writes', async () => {
    let hub = await start('hub-shared'), local = await start('local-shared');
    const database = new PrismaClient({ datasourceUrl: `file:${join(directory, 'hub-shared', 'test.db')}` });
    const stamp = new Date().toISOString();
    await database.conversation.create({ data: { id: 'shared-conversation', summary: 'SHARED-HISTORY-TEST', createdAt: stamp, updatedAt: stamp, messages: { create: { id: 'shared-message', role: 'assistant', content: '同一个工作区的聊天正文', status: 'completed', createdAt: stamp } } } });
    const publicTopic = (await hub.request('/api/topics', { name: '授权清单' })).data;
    const privateTopic = (await hub.request('/api/topics', { name: '范围外清单' })).data;
    const publicTask = (await hub.request('/api/tasks', { title: '授权任务', topicId: publicTopic.id })).data;
    const privateTask = (await hub.request('/api/tasks', { title: '范围外任务', topicId: privateTopic.id })).data;
    const paired = (await hub.request('/api/v1/sync/devices', { name: 'shared-fixture' })).data;
    expect((await local.request('/api/v1/sync/bind', { url: `http://127.0.0.1:${hub.port}`, token: paired.token })).status).toBe(200);
    expect((await local.request('/api/v1/sync/run', {})).status).toBe(200);
    expect((await local.request('/api/conversations')).data.items.map((item: any) => item.id)).toContain('shared-conversation');
    expect(JSON.stringify((await local.request('/api/conversations/shared-conversation/messages')).data)).toContain('同一个工作区的聊天正文');
    const computer = await local.request('/api/nodes', { name:'shared-computer-fixture' });
    expect(computer.status).toBe(200);
    expect(await database.agentNode.count({ where:{id:computer.data.node.id} })).toBe(1);
    expect(JSON.stringify((await local.request('/api/nodes')).data)).toContain(computer.data.node.id);
    expect((await local.request('/api/worktrees')).status).toBe(200);
    const project = await local.request('/api/projects', { name:'shared-project', defaultBranch:'main' });
    expect(project.status).toBe(200);
    expect((await local.request('/api/project-bindings/topic/'+publicTopic.id, {projectId:project.data.id}, 'PUT')).status).toBe(200);
    expect(await database.projectBinding.count({where:{projectId:project.data.id}})).toBe(1);
    const forbidden = await fetch(`http://127.0.0.1:${hub.port}/api/v1/sync/relay/api/v1/server/owner-key`, { headers: { authorization: `Bearer ${paired.token}` } });
    expect(forbidden.status).toBe(403);
    const localDb = new PrismaClient({datasourceUrl:`file:${join(directory,'local-shared','test.db')}`});
    await localDb.appSetting.upsert({ where: { id: 'default' }, create: { id: 'default', deepseekApiKey: 'local-original-search-key-3333', createdAt: stamp, updatedAt: stamp }, update: { deepseekApiKey: 'local-original-search-key-3333' } });
    await hub.request('/api/settings/web-search', { apiKey: 'hub-search-key-1111' }, 'PATCH');
    expect(await local.request('/api/settings/web-search')).toMatchObject({ status: 200, data: { configured: true, keyMasked: '••••1111', managedBy: 'application' } });
    const searchKey = 'shared-search-key-2222';
    const savedSearch = await local.request('/api/settings/web-search', { apiKey: searchKey }, 'PATCH');
    expect(savedSearch).toMatchObject({ status: 200, data: { configured: true, keyMasked: '••••2222' } });
    expect(JSON.stringify(savedSearch)).not.toContain(searchKey);
    expect((await database.appSetting.findUniqueOrThrow({ where: { id: 'default' } })).deepseekApiKey).toBe(searchKey);
    expect((await localDb.appSetting.findUniqueOrThrow({ where: { id: 'default' } })).deepseekApiKey).toBe('local-original-search-key-3333');
    expect((await local.request('/api/settings/web-search', undefined, 'DELETE')).status).toBe(200);
    expect((await database.appSetting.findUniqueOrThrow({ where: { id: 'default' } })).deepseekApiKey).toBe('');
    expect((await local.request('/api/settings/web-search')).data.configured).toBe(false);
    expect((await localDb.appSetting.findUniqueOrThrow({ where: { id: 'default' } })).deepseekApiKey).toBe('local-original-search-key-3333');
    const edited = await local.request('/api/tasks/'+publicTask.id, {title:'临时本机修改',expectedRevision:(await local.request('/api/tasks/'+publicTask.id)).data.revision}, 'PATCH');
    expect(edited.status).toBe(200);
    const localChange = await localDb.changeRecord.findFirstOrThrow({where:{entityId:publicTask.id},orderBy:{createdAt:'desc'}});
    expect((await local.request('/api/changes/'+localChange.id+'/undo', {})).status).toBe(200);
    expect((await local.request('/api/tasks/'+publicTask.id)).data.title).toBe('授权任务');
    await localDb.$disconnect();
    const rawFile=Buffer.from([0,1,2,3,255,0,10,128]);
    const opened=await local.request('/api/v1/library/uploads',{requestKey:crypto.randomUUID(),fileName:'raw-fixture.bin',mimeType:'application/octet-stream',size:rawFile.length});
    expect(opened.status).toBe(200);
    const received=await fetch(`http://127.0.0.1:${local.port}/api/v1/library/uploads/${opened.data.id}/content`,{method:'PUT',headers:{cookie:local.cookie,'x-csrf-token':local.csrf,'content-type':'application/octet-stream'},body:rawFile});
    expect(received.status,await received.text()).toBe(200);
    const committed=await local.request('/api/v1/commands',{requestId:crypto.randomUUID(),commands:[{kind:'material.create',input:{uploadId:opened.data.id,duplicateAction:'create',topicId:publicTopic.id,folderId:null,taskIds:[publicTask.id]}}]});
    expect(committed.status).toBe(200);expect(committed.data.status).toBe('applied');
    const material=committed.data.results[0];
    const source=await local.request('/api/v1/assistant/sources/material/'+material.id);expect(source.status).toBe(200);
    const rawDownload=await fetch(`http://127.0.0.1:${local.port}/api/v1/knowledge/materials/${material.id}/versions/1/attachment`,{headers:{cookie:local.cookie}});
    expect(rawDownload.status).toBe(200);expect(Buffer.from(await rawDownload.arrayBuffer())).toEqual(rawFile);
    expect((await local.request('/api/changes/'+committed.data.changeId+'/undo',{})).status).toBe(200);
    expect((await database.material.findUniqueOrThrow({where:{id:material.id}})).archivedAt).not.toBe(null);
    await local.request('/api/tasks/'+publicTask.id,{description:'共享活动记录',expectedRevision:(await local.request('/api/tasks/'+publicTask.id)).data.revision},'PATCH');await local.request('/api/v1/sync/run',{});
    const activity=await local.request('/api/tasks/'+publicTask.id+'/activity');expect(activity.status).toBe(200);expect(JSON.stringify(activity.data)).toContain('共享活动记录');
    expect((await local.request('/api/stats/overview?from=2026-10-01&to=2026-11-01&tz=Asia%2FShanghai')).status).toBe(200);
    const connection = (await local.request('/api/v1/connections', { name: 'scope-fixture', host: 'codex', topicIds: [publicTopic.id], includeInbox: false, autoActions: [] })).data;
    const scopedSearch = await fetch(`http://127.0.0.1:${local.port}/api/settings/web-search`, { headers: { authorization: `Bearer ${connection.token}` } });
    expect(scopedSearch.status).toBe(401);
    expect(connection.configuration.env.DOVUN_API_URL).toBe(`http://127.0.0.1:${local.port}`);
    const mcp = new Client({ name: 'relay-scope-fixture', version: '1.0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${local.port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${connection.token}` } } }));
    const listing = await mcp.callTool({ name: 'list_tasks', arguments: { limit: 20 } });
    const tasks = (listing.structuredContent as any).data.items;
    expect(tasks.map((item: any) => item.id)).toEqual([publicTask.id]);
    expect((await mcp.callTool({ name: 'get_capabilities', arguments: {} })).isError).not.toBe(true);
    expect((await mcp.callTool({ name: 'list_trash', arguments: { limit: 20 } })).isError).not.toBe(true);
    expect((await mcp.callTool({ name: 'get_task', arguments: { taskId: privateTask.id, includeImages: false } })).isError).toBe(true);
    const proposed = await mcp.callTool({ name: 'submit_commands', arguments: { requestId: crypto.randomUUID(), commands: [{ kind: 'task.update', targetId: publicTask.id, expectedRevision: tasks[0].revision, input: { title: '批准后的标题' } }] } });
    const proposal = (proposed.structuredContent as any).data;
    expect(proposal.status).toBe('pending_approval');
    expect((await hub.request(`/api/tasks/${publicTask.id}`)).data.title).toBe('授权任务');
    expect((await local.request(`/api/v1/proposals/${proposal.proposalId}/approve`, { expectedRevision: proposal.proposalRevision, requestId: crypto.randomUUID() })).status).toBe(200);
    await expect.poll(async () => (await local.request(`/api/tasks/${publicTask.id}`)).data.title, { timeout: 8000 }).toBe('批准后的标题');
    const imageBytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'white' } }).jpeg().toBuffer();
    const uploaded = await local.request(`/api/tasks/${publicTask.id}/images`, { attachmentBase64: imageBytes.toString('base64'), mimeType: 'image/jpeg' });
    expect(uploaded.status).toBe(200);
    const url = `http://127.0.0.1:${local.port}${uploaded.data.url}`;
    const download = await fetch(url, { headers: { cookie: local.cookie } });
    expect(download.status).toBe(200); expect(Buffer.from(await download.arrayBuffer())).toEqual(imageBytes);
    await mcp.close(); await database.$disconnect(); await stop(hub);
    // Allow the successful download's atomic cache write to finish before testing its offline read.
    await expect.poll(async () => (await fetch(url, { headers: { cookie: local.cookie } })).status, { timeout: 8000 }).toBe(200);
    const cached = await fetch(url, { headers: { cookie: local.cookie } });
    expect(cached.headers.get('x-dovun-offline')).toBe('1'); expect(cached.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await cached.arrayBuffer())).toEqual(imageBytes);
    expect(JSON.stringify((await local.request('/api/conversations/shared-conversation/messages')).data)).toContain('同一个工作区的聊天正文');
    const unauthenticated = await fetch(url, { headers: { 'x-dovun-replica': 'owner' } });
    expect(unauthenticated.status).toBe(401);
    const hubPort = hub.port, localPort = local.port;
    hub = await start('hub-shared', hubPort);
    await database.syncDevice.delete({ where: { id: paired.deviceId } });
    // The background sync path sees revocation first; the relay has not yet received a refusal.
    expect((await local.request('/api/v1/sync/run', {})).code).toBe('SYNC_AUTH_FAILED');
    await stop(hub); await stop(local); await database.$disconnect();
    local = await start('local-shared', localPort);
    const afterRestart = await fetch(url, { headers: { cookie: local.cookie } });
    expect(afterRestart.status).toBe(502); expect(afterRestart.headers.get('x-dovun-offline')).toBe(null);
    await stop(local);
  }, 60_000);
});
