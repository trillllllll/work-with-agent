import { AsyncLocalStorage } from 'node:async_hooks';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { shouldAttachTaskImage, taskDetailImageRefs, taskImageAttachPerImage, taskImageAttachTotal, type TaskImageRef } from './task-image-content.js';

export const mcpCredential = new AsyncLocalStorage<string>();

function credential() {
  const value = mcpCredential.getStore() ?? process.env.WWA_CONNECTION_TOKEN;
  if (!value) throw new Error('WWA_CONNECTION_TOKEN is required; create a scoped connection in the workspace');
  return value;
}

function apiBase() {
  const base = new URL(process.env.WWA_API_URL ?? `http://127.0.0.1:${Number(process.env.PORT) || 3016}`);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || !['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('WWA_API_URL must be a loopback HTTP(S) origin');
  return base;
}

export function createMcpServer() {
  const server = new McpServer({ name: 'work-with-agent', version: '2.0.0' }, {
    instructions: 'Read only the lists authorized for this connection. Read current revisions before editing. Writes require a stable requestId; reuse it only to retry identical content. pending_approval means data has NOT changed. Never claim a proposal was applied. Omit fields to preserve them, use null to clear nullable fields and [] to clear sets. Handoff results do not complete tasks; the owner reviews results. Preserve source IDs and revisions when proposing memories. Description paths like /api/tasks/{taskId}/images/{imageId} are not fetchable URLs. get_task attaches those screenshots as image content. Call get_task_image for one screenshot that was omitted.',
  });

  type ToolText = { type: 'text'; text: string };
  type ToolImage = { type: 'image'; data: string; mimeType: string };
  type ToolResult = { content: Array<ToolText | ToolImage>; structuredContent: Record<string, unknown>; isError?: boolean };
  function toolResult(payload: Record<string, unknown>, status: number, content: Array<ToolText | ToolImage> = []): ToolResult {
    const result = { ...payload, httpStatus: status, retryable: status === 429 || status >= 500 };
    const text: ToolText = { type: 'text', text: JSON.stringify(result) };
    return { content: [text, ...content], structuredContent: result, ...(status >= 200 && status < 300 ? {} : { isError: true }) };
  }
  function unavailable(error: unknown): ToolResult {
    const result = { code: 'CONNECTION_UNAVAILABLE', message: error instanceof Error ? error.message : 'Local workspace is unavailable', retryable: true };
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: true };
  }
  async function request(path: string, method = 'GET', body?: unknown): Promise<ToolResult> {
    try {
      const response = await fetch(new URL(path, apiBase()), { method, headers: { Authorization: `Bearer ${credential()}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000), redirect: 'error' });
      const payload = await response.json() as Record<string, unknown>;
      return toolResult(payload, response.status);
    } catch (error) {
      return unavailable(error);
    }
  }
  async function readTaskImage(taskId: string, imageId: string, byteLimit: number | null): Promise<{ ok: true; mimeType: string; byteSize: number; bytes?: Buffer } | { ok: false; status: number; payload: Record<string, unknown> } | { ok: false; unavailable: unknown }> {
    try {
      const response = await fetch(new URL(`/api/v1/tasks/${encodeURIComponent(taskId)}/images/${encodeURIComponent(imageId)}`, apiBase()), { headers: { Authorization: `Bearer ${credential()}` }, signal: AbortSignal.timeout(30_000), redirect: 'error' });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({ message: '图片不存在' })) as Record<string, unknown>;
        return { ok: false, status: response.status, payload };
      }
      const mimeType = (response.headers.get('content-type') ?? '').split(';')[0].trim();
      if (mimeType !== 'image/jpeg' && mimeType !== 'image/webp') {
        await response.body?.cancel().catch(() => {});
        return { ok: false, status: 415, payload: { code: 'INVALID_IMAGE', message: '只接受 WebP 或 JPEG 图片' } };
      }
      const declared = Number(response.headers.get('content-length'));
      if (byteLimit !== null && Number.isFinite(declared) && declared > byteLimit) {
        await response.body?.cancel().catch(() => {});
        return { ok: true, mimeType, byteSize: declared };
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (byteLimit !== null && bytes.byteLength > byteLimit) return { ok: true, mimeType, byteSize: bytes.byteLength };
      return { ok: true, mimeType, byteSize: bytes.byteLength, bytes };
    } catch (error) {
      return { ok: false, unavailable: error };
    }
  }
  function imageNote(ref: TaskImageRef, fields: Record<string, unknown>) {
    return { type: 'text' as const, text: JSON.stringify({ image: { taskId: ref.taskId, imageId: ref.imageId, ...(ref.alt ? { alt: ref.alt } : {}), ...fields } }) };
  }
  async function attachTaskImages(result: ToolResult): Promise<ToolResult> {
    const data = result.structuredContent.data;
    if (!data || typeof data !== 'object') return result;
    const refs = taskDetailImageRefs(data as { id?: unknown; description?: unknown; children?: unknown });
    if (!refs.length) return result;
    const content = [...result.content];
    let usedBytes = 0;
    for (const [index, ref] of refs.entries()) {
      const byteLimit = shouldAttachTaskImage(index, 1, usedBytes) ? Math.min(taskImageAttachPerImage, taskImageAttachTotal - usedBytes) : 0;
      const image = await readTaskImage(ref.taskId, ref.imageId, byteLimit);
      if (!image.ok) {
        content.push(imageNote(ref, { included: false, unavailable: true, ...('status' in image ? { status: image.status } : {}) }));
        continue;
      }
      if (!image.bytes || !shouldAttachTaskImage(index, image.byteSize, usedBytes)) {
        content.push(imageNote(ref, { included: false, mimeType: image.mimeType, byteSize: image.byteSize, readWith: 'get_task_image' }));
        continue;
      }
      usedBytes += image.byteSize;
      content.push(imageNote(ref, { included: true, mimeType: image.mimeType, byteSize: image.byteSize }));
      content.push({ type: 'image', data: image.bytes.toString('base64'), mimeType: image.mimeType });
    }
    return { ...result, content };
  }
  const pagination = { cursor: z.string().optional(), limit: z.number().int().min(1).max(100).optional() };
  function query(path: string, args: Record<string, unknown>) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(args)) if (value !== undefined) params.set(key, Array.isArray(value) ? value.join(',') : String(value));
    return request(`${path}?${params}`);
  }
  const id = z.string().min(1);
  const command = z.object({ kind: id, targetId: id.optional(), expectedRevision: z.number().int().positive().optional(), input: z.record(z.unknown()).optional(), clientRef: id.optional(), evidence: z.array(z.object({ type: z.enum(['task', 'material', 'memory']), id, revision: z.number().int().positive(), hash: z.string().optional() })).optional() });
  const commands = z.object({ requestId: id, commands: z.array(command).min(1).max(50), previewToken: z.string().optional() });
  server.registerTool('list_tasks', { description: 'Query authorized tasks with pagination. dueFrom/To filter the start date; scheduledFrom/To filter calendar overlap including cross-day ranges, excluding the end boundary. Deleted and archived items are excluded by default.', inputSchema: { ...pagination, topicId: id.optional(), inbox: z.boolean().optional(), q: z.string().optional(), status: z.enum(['open', 'done', 'all', 'todo', 'doing', 'blocked']).optional(), dueFrom: z.string().optional(), dueTo: z.string().optional(), scheduledFrom: z.string().optional(), scheduledTo: z.string().optional(), tagIds: z.array(id).optional(), sort: z.enum(['manual', 'date', 'priority']).optional() } }, (args) => query('/api/v1/tasks', args));
  server.registerTool('get_task', { description: 'Read task fields, revision and children before proposing an edit. Screenshots referenced in the description are attached as image content. Paths like /api/tasks/{taskId}/images/{imageId} are not fetchable. Call get_task_image for a single omitted screenshot.', inputSchema: { taskId: id } }, async ({ taskId }) => {
    const result = await request(`/api/v1/tasks/${encodeURIComponent(taskId)}`);
    return result.isError ? result : attachTaskImages(result);
  });
  server.registerTool('get_task_image', { description: 'Read one JPEG or WebP screenshot that belongs to an authorized task. Description image paths are not fetchable URLs.', inputSchema: { taskId: id, imageId: id } }, async ({ taskId, imageId }) => {
    const image = await readTaskImage(taskId, imageId, null);
    if (!image.ok) return 'unavailable' in image ? unavailable(image.unavailable) : toolResult(image.payload, image.status);
    if (!image.bytes) return toolResult({ data: null, code: 'INVALID_IMAGE', error: '图片内容不可用' }, 502);
    const meta = { data: { taskId, imageId, mimeType: image.mimeType, byteSize: image.byteSize }, error: null };
    return toolResult(meta, 200, [{ type: 'image', data: image.bytes.toString('base64'), mimeType: image.mimeType }]);
  });
  server.registerTool('list_tags', { description: 'List only tags associated with tasks in this connection scope.', inputSchema: pagination }, (args) => query('/api/v1/tags', args));
  server.registerTool('list_trash', { description: 'List deleted tasks in the authorized scope before proposing task.restore. Follow nextCursor for all members.', inputSchema: pagination }, (args) => query('/api/v1/trash/tasks', args));
  server.registerTool('get_task_history', { description: 'Read authorized task assignment history. Transitions outside this scope are omitted.', inputSchema: { taskId: id, ...pagination } }, ({ taskId, ...args }) => query(`/api/v1/tasks/${encodeURIComponent(taskId)}/history`, args));
  server.registerTool('list_changes', { description: 'Read safe audit metadata in scope; full private snapshots remain owner-only.', inputSchema: { ...pagination, entityType: id.optional(), entityId: id.optional() } }, (args) => query('/api/v1/changes', args));
  server.registerTool('list_topics', { description: 'List authorized lists; new lists are not automatically authorized.', inputSchema: pagination }, (args) => query('/api/v1/topics', args));
  server.registerTool('get_topic', { description: 'Read an authorized list.', inputSchema: { topicId: id } }, ({ topicId }) => request(`/api/v1/topics/${encodeURIComponent(topicId)}`));
  server.registerTool('get_capabilities', { description: 'Read the common command catalogue and supported input shapes.', inputSchema: {} }, () => request('/api/v1/tools'));
  server.registerTool('preview_commands', { description: 'Validate and preview an atomic command group, including affected rows and relationship preconditions.', inputSchema: commands.shape }, (args) => request('/api/v1/commands/preview', 'POST', args));
  server.registerTool('submit_commands', { description: 'Submit up to 50 atomic commands using kind, targetId, expectedRevision and input. Use task.create/update/delete/restore/reorder, topic.create/update/archive/restore, tag.create/update/delete, and knowledge commands from get_capabilities. Applied and pending_approval are distinct outcomes.', inputSchema: commands.shape }, (args) => request('/api/v1/commands', 'POST', args));
  server.registerTool('get_proposal', { description: 'Read the state of a previously submitted proposal. Only the owner can approve.', inputSchema: { proposalId: id } }, ({ proposalId }) => request(`/api/v1/proposals/${encodeURIComponent(proposalId)}`));
  server.registerTool('search_knowledge', { description: 'Search authorized task, material and memory sources; preserve evidence versions. scope=library searches material filename, title, tags and extracted body.', inputSchema: { ...pagination, q: id, topicId: id.optional(), scope: z.literal('library').optional(), types: z.array(z.enum(['material', 'task', 'memory'])).optional(), folderId: z.string().optional(), tagIds: z.array(id).optional(), taskId: id.optional(), archived: z.enum(['exclude', 'only', 'include']).optional(), taskTopicId: z.string().optional(), kind: z.enum(['text', 'markdown', 'link', 'thread', 'attachment']).optional() } }, (args) => args.scope === 'library' ? query('/api/v1/library/search', { q: args.q, cursor: args.cursor, limit: args.limit, folderId: args.folderId, tagIds: args.tagIds, taskId: args.taskId, archived: args.archived, taskTopicId: args.taskTopicId, kind: args.kind }) : query('/api/v1/knowledge/search', { q: args.q, topicId: args.topicId, cursor: args.cursor, limit: args.limit }));
  server.registerTool('list_materials', { description: 'List authorized saved materials. scope=library lists the global library inside this connection grant.', inputSchema: { ...pagination, topicId: id.optional(), taskId: id.optional(), scope: z.literal('library').optional(), folderId: z.string().optional(), tagIds: z.array(id).optional(), archived: z.enum(['exclude', 'only', 'include']).optional(), taskTopicId: z.string().optional(), kind: z.enum(['text', 'markdown', 'link', 'thread', 'attachment']).optional() } }, (args) => args.scope === 'library' ? query('/api/v1/library/materials', { cursor: args.cursor, limit: args.limit, folderId: args.folderId, tagIds: args.tagIds, taskId: args.taskId, archived: args.archived, taskTopicId: args.taskTopicId, kind: args.kind }) : query('/api/v1/knowledge/materials', { topicId: args.topicId, taskId: args.taskId, cursor: args.cursor, limit: args.limit }));
  server.registerTool('get_material', { description: 'Read saved material and its immutable source versions.', inputSchema: { materialId: id } }, ({ materialId }) => request(`/api/v1/knowledge/materials/${encodeURIComponent(materialId)}`));
  server.registerTool('get_material_content', { description: 'Read extracted text chunks for one material revision. Citations use the returned chunk id and locator.', inputSchema: { materialId: id, revision: z.number().int().positive(), cursor: z.string().optional(), limit: z.number().int().min(1).max(100).optional() } }, ({ materialId, ...args }) => query(`/api/v1/library/materials/${encodeURIComponent(materialId)}/content`, args));
  server.registerTool('list_library_folders', { description: 'List library folders. Folder changes still go through submit_commands and stay pending until the owner approves.', inputSchema: {} }, () => request('/api/v1/library/folders'));
  server.registerTool('list_library_tags', { description: 'List library tags. Tag changes still go through submit_commands and stay pending until the owner approves.', inputSchema: {} }, () => request('/api/v1/library/tags'));
  server.registerTool('list_material_tasks', { description: 'List tasks linked to a material that this connection can read.', inputSchema: { materialId: id, ...pagination } }, ({ materialId, ...args }) => query(`/api/v1/library/materials/${encodeURIComponent(materialId)}/tasks`, args));
  server.registerTool('list_task_materials', { description: 'List materials linked to a task that this connection can read.', inputSchema: { taskId: id, ...pagination } }, ({ taskId, ...args }) => query(`/api/v1/library/tasks/${encodeURIComponent(taskId)}/materials`, args));
  server.registerTool('list_memories', { description: 'Read scoped project memories with importance, labels, origin, source health and lifecycle state. status=active is the default; history includes retired and superseded; all returns every state.', inputSchema: { ...pagination, topicId: id.optional(), history: z.boolean().optional(), status: z.enum(['active', 'history', 'all']).optional(), q: z.string().optional() } }, (args) => query('/api/v1/knowledge/memories', args));
  server.registerTool('get_knowledge_graph', { description: 'Read the scoped evidence graph. range 1-5 expands from a literal fast match or a smart content match. Nodes are memories, materials, tasks, artifacts and entities.', inputSchema: { topicId: id.optional(), q: z.string().optional(), mode: z.enum(['fast', 'smart']).optional(), range: z.number().int().min(1).max(5).optional(), focusType: z.enum(['memory', 'material', 'task', 'artifact', 'entity']).optional(), focusId: id.optional(), includeHistory: z.boolean().optional() } }, (args) => query('/api/v1/knowledge/graph', { ...args, includeHistory: args.includeHistory ? 'true' : undefined }));
  server.registerTool('get_memory', { description: 'Read a memory and immutable revision history with source references.', inputSchema: { memoryId: id } }, ({ memoryId }) => request(`/api/v1/knowledge/memories/${encodeURIComponent(memoryId)}`));
  server.registerTool('get_brief', { description: 'Read the structured current brief and user notes for an authorized scope.', inputSchema: { topicId: id.optional() } }, (args) => query('/api/v1/knowledge/brief', args));
  server.registerTool('get_organization_request', { description: 'Read frozen inputs and output contract for an explicitly requested organization job.', inputSchema: { requestId: id } }, ({ requestId }) => request(`/api/v1/knowledge/organizations/${encodeURIComponent(requestId)}`));
  server.registerTool('submit_organization_result', { description: 'Save evidence-backed candidate commands from the organization snapshot, never confirm them.', inputSchema: { organizationId: id, summary: z.string().optional(), commands: z.array(command).max(50) } }, ({ organizationId, ...input }) => request(`/api/v1/knowledge/organizations/${encodeURIComponent(organizationId)}/candidates`, 'POST', input));
  server.registerTool('list_handoffs', { description: 'List handoffs available in this connection scope.', inputSchema: { taskId: id.optional() } }, (args) => query('/api/v1/handoffs', args));
  server.registerTool('get_handoff', { description: 'Read the frozen task goal, constraints, acceptance criteria and selected source snapshots.', inputSchema: { handoffId: id } }, ({ handoffId }) => request(`/api/v1/handoffs/${encodeURIComponent(handoffId)}`));
  server.registerTool('claim_handoff', { description: 'Atomically claim an existing handoff. Store the returned Run ID and claim token for reporting.', inputSchema: { handoffId: id, requestId: id } }, ({ handoffId, requestId }) => request(`/api/v1/handoffs/${encodeURIComponent(handoffId)}/claim`, 'POST', { requestId }));
  server.registerTool('report_progress', { description: 'Append progress to the claimed Run, without marking it returned or completing the task.', inputSchema: { runId: id, claimToken: id, eventId: id, message: z.string(), externalSessionId: id.optional() } }, ({ runId, ...input }) => request(`/api/v1/runs/${encodeURIComponent(runId)}/progress`, 'POST', input));
  server.registerTool('report_run', { description: 'Return immutable results to the claimed Run. Reuse eventId for identical retries. Task completion requires owner review.', inputSchema: { runId: id, claimToken: id, eventId: id, externalSessionId: id.optional(), result: z.object({ outcome: z.enum(['ready_for_review', 'needs_input', 'blocked_permissions', 'partial']), summary: z.string(), unfinished: z.array(z.string()).optional(), proposedCommands: z.array(command).optional(), questions: z.array(z.string()).default([]), artifacts: z.array(z.record(z.unknown())).default([]), checks: z.array(z.unknown()).default([]) }) } }, ({ runId, ...input }) => request(`/api/v1/runs/${encodeURIComponent(runId)}/report`, 'POST', input));
  return server;
}
