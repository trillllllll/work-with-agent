import { AsyncLocalStorage } from 'node:async_hooks';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { mcpLoopbackHeaders } from '../application/security.js';
import { requestLocale } from '../i18n/index.js';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_TASK,
  MAX_TEXT_ATTACHMENT_CHARS,
  MAX_TOTAL_IMAGE_BYTES,
  attachmentFileName,
  canonicalInlineImageMime,
  countCapReason,
  extractTaskImageRefs,
  isInlineImageMime,
  isTextLikeAttachment,
  materialMetadata,
  prepareImage,
  resolveAttachmentMime,
  taskImageCaption,
  taskImageSummary,
  totalSizeCapReason,
  truncateUtf8,
} from './media.js';

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

// HTTP MCP forwards the caller's Accept-Language; stdio MCP can set WWA_LANGUAGE. Otherwise the API answers in zh-CN.
function forwardedLanguage(): Record<string, string> {
  const language = requestLocale() ?? process.env.WWA_LANGUAGE;
  return language ? { 'Accept-Language': language } : {};
}

export function createMcpServer() {
  const server = new McpServer({ name: 'work-with-agent', version: '2.0.0' }, {
    instructions: 'Read only the lists authorized for this connection. Read current revisions before editing. Writes require a stable requestId; reuse it only to retry identical content. pending_approval means data has NOT changed. Never claim a proposal was applied. Omit fields to preserve them, use null to clear nullable fields and [] to clear sets. Handoff results do not complete tasks; the owner reviews results. Preserve source IDs and revisions when proposing memories. get_task returns referenced description images as image content (6 images, 1.5 MiB, 2000px, 6 MiB total; includeImages:false skips them). Use get_task_image for one image and get_material_attachment for a material file.',
  });

  async function request(path: string, method = 'GET', body?: unknown) {
    try {
      const response = await fetch(new URL(path, apiBase()), { method, headers: { Authorization: `Bearer ${credential()}`, 'Content-Type': 'application/json', ...forwardedLanguage(), ...mcpLoopbackHeaders() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000), redirect: 'error' });
      const payload = await response.json() as Record<string, unknown>;
      const result = { ...payload, httpStatus: response.status, retryable: response.status === 429 || response.status >= 500 };
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result, ...(response.ok ? {} : { isError: true }) };
    } catch (error) {
      const result = { code: 'CONNECTION_UNAVAILABLE', message: error instanceof Error ? error.message : 'Local workspace is unavailable', retryable: true };
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result, isError: true };
    }
  }
  function toolError(code: string, message: string, httpStatus: number | null, retryable: boolean) {
    const result = { code, message, httpStatus, retryable };
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result, isError: true as const };
  }
  function errorBody(text: string, status: number) {
    const fallback = text.trim().slice(0, 500) || `HTTP ${status}`;
    try {
      const payload = JSON.parse(text) as Record<string, unknown>;
      const code = typeof payload.code === 'string' && payload.code ? payload.code : 'REQUEST_FAILED';
      let message = fallback;
      if (typeof payload.message === 'string' && payload.message) message = payload.message;
      else if (typeof payload.error === 'string' && payload.error) message = payload.error;
      else if (payload.error && typeof payload.error === 'object') message = JSON.stringify(payload.error).slice(0, 500);
      return { code, message };
    } catch {
      return { code: 'REQUEST_FAILED', message: fallback };
    }
  }
  async function readCapped(response: Response, limit: number) {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > limit) {
      await response.body?.cancel().catch(() => {});
      return { ok: false as const, code: 'ATTACHMENT_TOO_LARGE', message: `response exceeds fetch cap of ${limit} bytes` };
    }
    if (!response.body) {
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength > limit) return { ok: false as const, code: 'ATTACHMENT_TOO_LARGE', message: `response exceeds fetch cap of ${limit} bytes` };
      return { ok: true as const, bytes };
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        return { ok: false as const, code: 'ATTACHMENT_TOO_LARGE', message: `response exceeds fetch cap of ${limit} bytes` };
      }
      chunks.push(Buffer.from(value));
    }
    return { ok: true as const, bytes: Buffer.concat(chunks) };
  }
  async function requestBinary(path: string) {
    try {
      const response = await fetch(new URL(path, apiBase()), { method: 'GET', headers: { Authorization: `Bearer ${credential()}`, ...forwardedLanguage(), ...mcpLoopbackHeaders() }, signal: AbortSignal.timeout(30_000), redirect: 'error' });
      const body = await readCapped(response, MAX_ATTACHMENT_BYTES);
      if (!body.ok) return { ok: false as const, status: 413, message: body.message, code: body.code, retryable: false };
      if (!response.ok) {
        const parsed = errorBody(body.bytes.toString('utf8'), response.status);
        return { ok: false as const, status: response.status, message: parsed.message, code: parsed.code, retryable: response.status === 429 || response.status >= 500 };
      }
      return { ok: true as const, status: response.status, bytes: body.bytes, headers: response.headers };
    } catch (error) {
      return { ok: false as const, status: null, code: 'CONNECTION_UNAVAILABLE', message: error instanceof Error ? error.message : 'Local workspace is unavailable', retryable: true };
    }
  }
  function taskDescription(payload: unknown) {
    if (!payload || typeof payload !== 'object' || !('data' in payload)) return '';
    const data = (payload as { data?: unknown }).data;
    if (!data || typeof data !== 'object' || !('description' in data)) return '';
    const description = (data as { description?: unknown }).description;
    return typeof description === 'string' ? description : '';
  }
  async function taskImageBlocks(taskId: string, description: string) {
    const refs = extractTaskImageRefs(taskId, description);
    if (!refs.length) return [];
    const skipped: Array<{ imageId: string; reason: string }> = [];
    const attached: Array<{ imageId: string; data: string; mimeType: string }> = [];
    let used = 0;
    for (const [index, imageId] of refs.entries()) {
      if (index >= MAX_IMAGES_PER_TASK) {
        skipped.push({ imageId, reason: countCapReason() });
        continue;
      }
      try {
        const fetched = await requestBinary(`/api/v1/tasks/${encodeURIComponent(taskId)}/images/${encodeURIComponent(imageId)}`);
        if (!fetched.ok) {
          skipped.push({ imageId, reason: `fetch error (HTTP ${fetched.status ?? 'none'}): ${fetched.message}` });
          continue;
        }
        const mimeType = canonicalInlineImageMime(fetched.headers.get('content-type') ?? 'application/octet-stream');
        const prepared = await prepareImage(fetched.bytes, mimeType);
        if (!prepared.ok) {
          skipped.push({ imageId, reason: prepared.reason });
          continue;
        }
        if (used + prepared.byteSize > MAX_TOTAL_IMAGE_BYTES) {
          skipped.push({ imageId, reason: totalSizeCapReason() });
          continue;
        }
        used += prepared.byteSize;
        attached.push({ imageId, data: prepared.data, mimeType: prepared.mimeType });
      } catch (error) {
        skipped.push({ imageId, reason: `fetch error: ${error instanceof Error ? error.message : 'image request failed'}` });
      }
    }
    const blocks: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [];
    attached.forEach((image, index) => {
      blocks.push({ type: 'text', text: taskImageCaption(index + 1, attached.length, taskId, image.imageId) });
      blocks.push({ type: 'image', data: image.data, mimeType: image.mimeType });
    });
    blocks.push({ type: 'text', text: taskImageSummary(skipped) });
    return blocks;
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
  server.registerTool('list_plan_time_bands', { description: 'Read the saved weekly plan time bands. They are repeating backgrounds, not tasks. Omit at to return every band. Pass at as a local wall time YYYY-MM-DDTHH:mm to list every band that contains that minute. The end minute is excluded. This does not create or edit bands.', inputSchema: { at: z.string().optional() } }, (args) => query('/api/v1/plan/time-bands', args));
  server.registerTool('get_task', { description: 'Read task fields, revision and children before proposing an edit. Description images referenced as /api/tasks/{taskId}/images/{imageId} are returned as image content after the JSON (at most 6 images, each at most 1.5 MiB and 2000px, 6 MiB total). Pass includeImages:false to skip them. Use get_task_image for one image.', inputSchema: { taskId: id, includeImages: z.boolean().optional() } }, async ({ taskId, includeImages }) => {
    const result = await request(`/api/v1/tasks/${encodeURIComponent(taskId)}`);
    if (result.isError || includeImages === false) return result;
    try {
      const extra = await taskImageBlocks(taskId, taskDescription(result.structuredContent));
      if (!extra.length) return result;
      return { ...result, content: [...result.content, ...extra] };
    } catch (error) {
      const text = `Skipped images:\n- description images: fetch error (${error instanceof Error ? error.message : 'image request failed'})\nUse get_task_image to fetch a specific image.`;
      return { ...result, content: [...result.content, { type: 'text' as const, text }] };
    }
  });
  server.registerTool('get_task_image', { description: 'Fetch one task description image by taskId and imageId. Returns the image bytes, resized to at most 2000px and 1.5 MiB when needed.', inputSchema: { taskId: id, imageId: id } }, async ({ taskId, imageId }) => {
    const fetched = await requestBinary(`/api/v1/tasks/${encodeURIComponent(taskId)}/images/${encodeURIComponent(imageId)}`);
    if (!fetched.ok) return toolError(fetched.code, fetched.message, fetched.status, fetched.retryable);
    const originalMimeType = canonicalInlineImageMime(fetched.headers.get('content-type') ?? 'application/octet-stream');
    const prepared = await prepareImage(fetched.bytes, originalMimeType);
    if (!prepared.ok) return toolError('IMAGE_UNAVAILABLE', prepared.reason, fetched.status, false);
    return { content: [{ type: 'text' as const, text: `imageId=${imageId} originalMimeType=${originalMimeType} originalByteSize=${fetched.bytes.byteLength} resized=${prepared.resized}` }, { type: 'image' as const, data: prepared.data, mimeType: prepared.mimeType }] };
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
  server.registerTool('get_material', { description: 'Read saved material and its immutable source versions. Use get_material_attachment to read a file attachment.', inputSchema: { materialId: id } }, ({ materialId }) => request(`/api/v1/knowledge/materials/${encodeURIComponent(materialId)}`));
  server.registerTool('get_material_attachment', { description: 'Read a material version file. Images (png, jpeg, webp, gif) are returned as image content with the same size limits as get_task. Text-like files are returned as a UTF-8 resource truncated at 100000 characters. PDF and other binary files up to 3 MiB are returned as a base64 resource; larger files are not inlined. Use get_material_content for extracted text. Downloads are capped at 20 MiB.', inputSchema: { materialId: id, revision: z.number().int().positive() } }, async ({ materialId, revision }) => {
    const fetched = await requestBinary(`/api/v1/knowledge/materials/${encodeURIComponent(materialId)}/versions/${encodeURIComponent(String(revision))}/attachment`);
    if (!fetched.ok) return toolError(fetched.code, fetched.message, fetched.status, fetched.retryable);
    const fileName = attachmentFileName(fetched.headers.get('content-disposition'));
    const mimeType = resolveAttachmentMime(fetched.headers.get('x-wwa-mime-type'), fileName);
    const byteSize = fetched.bytes.byteLength;
    const metadata = { type: 'text' as const, text: materialMetadata({ materialId, revision, fileName, mimeType, byteSize }) };
    const uri = `wwa://materials/${materialId}/versions/${revision}/attachment`;
    if (isInlineImageMime(mimeType)) {
      const prepared = await prepareImage(fetched.bytes, canonicalInlineImageMime(mimeType));
      if (!prepared.ok) return { content: [metadata, { type: 'text' as const, text: prepared.reason }] };
      return { content: [metadata, { type: 'image' as const, data: prepared.data, mimeType: prepared.mimeType }] };
    }
    if (isTextLikeAttachment(mimeType, fileName)) {
      const decoded = truncateUtf8(fetched.bytes, MAX_TEXT_ATTACHMENT_CHARS);
      const note = decoded.truncated ? { type: 'text' as const, text: `Truncated to ${MAX_TEXT_ATTACHMENT_CHARS} characters.` } : null;
      const resource = { type: 'resource' as const, resource: { uri, mimeType, text: decoded.text } };
      return { content: note ? [metadata, note, resource] : [metadata, resource] };
    }
    const inlineLimit = MAX_IMAGE_BYTES * 2;
    const recommend = { type: 'text' as const, text: byteSize <= inlineLimit ? 'Use get_material_content for extracted text.' : `Attachment is ${byteSize} bytes and exceeds the ${inlineLimit} byte inline limit. Use get_material_content for extracted text.` };
    if (byteSize > inlineLimit) return { content: [metadata, recommend] };
    return { content: [metadata, recommend, { type: 'resource' as const, resource: { uri, mimeType, blob: fetched.bytes.toString('base64') } }] };
  });
  server.registerTool('get_material_content', { description: 'Read extracted text chunks for one material revision. Citations use the returned chunk id and locator.', inputSchema: { materialId: id, revision: z.number().int().positive(), cursor: z.string().optional(), limit: z.number().int().min(1).max(100).optional() } }, ({ materialId, ...args }) => query(`/api/v1/library/materials/${encodeURIComponent(materialId)}/content`, args));
  server.registerTool('list_library_folders', { description: 'List library folders. Folder changes still go through submit_commands and stay pending until the owner approves.', inputSchema: {} }, () => request('/api/v1/library/folders'));
  server.registerTool('list_library_tags', { description: 'List library tags. Tag changes still go through submit_commands and stay pending until the owner approves.', inputSchema: {} }, () => request('/api/v1/library/tags'));
  server.registerTool('list_material_tasks', { description: 'List tasks linked to a material that this connection can read.', inputSchema: { materialId: id, ...pagination } }, ({ materialId, ...args }) => query(`/api/v1/library/materials/${encodeURIComponent(materialId)}/tasks`, args));
  server.registerTool('list_task_materials', { description: 'List materials linked to a task that this connection can read. Use get_material_attachment to read a file attachment.', inputSchema: { taskId: id, ...pagination } }, ({ taskId, ...args }) => query(`/api/v1/library/tasks/${encodeURIComponent(taskId)}/materials`, args));
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
