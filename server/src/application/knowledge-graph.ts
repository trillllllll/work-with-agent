import { z } from 'zod';
import { prisma } from '../infrastructure/prisma.js';
import { registerCommandHandler } from './commands.js';
import { jsonSchema } from './command-catalog.js';
import { registerUndoHandler, type UndoRecord } from './undo-registry.js';
import { recordChange, type MutationContext } from './workspace-store.js';
import { assertOwner, type Actor } from './security.js';
import { checkKnowledgeScope, knowledgeFailure, knowledgeHash, knowledgeNow, mentionNames, memoryOrigin, persistMemory, readEvidence, readLabels, syncLabelEntities, type EvidenceRef, type KnowledgeDb } from './knowledge.js';

const entityKinds = ['concept', 'person', 'tool', 'project', 'other'] as const;
const nodeTypes = ['memory', 'material', 'task', 'artifact', 'entity'] as const;
type NodeType = typeof nodeTypes[number];
const entitySchema = z.object({ topicId: z.string().min(1).nullable().default(null), name: z.string().trim().min(1).max(80), kind: z.enum(entityKinds).default('concept'), description: z.string().max(2000).default('') }).strict();
const entityUpdateSchema = z.object({ name: z.string().trim().min(1).max(80).optional(), kind: z.enum(entityKinds).optional(), description: z.string().max(2000).optional() }).strict();
const linkSchema = z.object({ topicId: z.string().min(1).nullable().default(null), fromType: z.enum(nodeTypes), fromId: z.string().min(1), toType: z.enum(nodeTypes), toId: z.string().min(1), relation: z.enum(['related', 'about', 'contrasts']), note: z.string().max(500).default('') }).strict();
const crystalSchema = z.object({ topicId: z.string().min(1).nullable().default(null), entityId: z.string().min(1), title: z.string().trim().min(1).max(300).optional(), content: z.string().min(1).max(500_000).optional(), reason: z.string().trim().min(1).max(1000).default('多条记忆沉淀为稳定参考') }).strict();
const graphQuery = z.object({ q: z.string().max(500).default(''), mode: z.enum(['fast', 'smart']).default('fast'), range: z.number().int().min(1).max(5).default(1), focusType: z.enum(nodeTypes).optional(), focusId: z.string().min(1).optional(), includeHistory: z.boolean().default(false) });

const nodeKey = (type: string, id: string) => `${type}:${id}`;
const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();
const dayKey = (iso: string) => iso.slice(0, 10);
const dayLabel = (key: string) => { const [year, month, day] = key.split('-'); return `${year}年${Number(month)}月${Number(day)}日`; };
const excerpt = (value: string, size = 240) => value.replace(/\s+/g, ' ').trim().slice(0, size);

export type GraphNode = { id: string; rawId: string; type: NodeType; title: string; kind?: string; status?: string; excerpt?: string; description?: string; importance?: number; labels?: string[]; origin?: string; revision?: number; memoryCount?: number; createdAt?: string };
export type GraphEdge = { id: string; from: string; to: string; relation: string; note?: string; manual: boolean };

async function located(tx: KnowledgeDb, type: NodeType, id: string) {
  if (type === 'memory') { const row = await tx.memory.findUnique({ where: { id } }); return row && { topicId: row.topicId, title: row.title }; }
  if (type === 'material') { const row = await tx.material.findUnique({ where: { id } }); return row && { topicId: row.topicId, title: row.title }; }
  if (type === 'task') { const row = await tx.task.findUnique({ where: { id } }); return row && { topicId: row.topicId, title: row.title }; }
  if (type === 'entity') { const row = await tx.entity.findUnique({ where: { id } }); return row && { topicId: row.topicId, title: row.name }; }
  const row = await tx.artifact.findUnique({ where: { id }, include: { run: { include: { handoff: true } } } });
  if (!row) return null;
  const task = await tx.task.findUnique({ where: { id: row.run.handoff.taskId } });
  return task && { topicId: task.topicId, title: row.name };
}

async function crystalSources(tx: KnowledgeDb, entity: { id: string; topicId: string | null; name: string }) {
  const [memories, links] = await Promise.all([
    tx.memory.findMany({ where: { topicId: entity.topicId, status: 'active', kind: { not: 'crystal' } } }),
    tx.graphLink.findMany({ where: { toType: 'entity', toId: entity.id, fromType: 'memory', relation: { in: ['label', 'mentions', 'about', 'related'] } } }),
  ]);
  const linked = new Set(links.map((link) => link.fromId));
  return memories.filter((memory) => readLabels(memory.labels).includes(entity.name) || mentionNames(memory.title, memory.content).includes(entity.name) || linked.has(memory.id));
}

function compileCrystal(name: string, sources: Array<{ id: string; title: string; content: string; revision: number }>) {
  const body = sources.map((source, index) => `## ${index + 1}. ${source.title}\n\n${source.content.slice(0, 800)}\n\n来源 memory:${source.id} 版本 ${source.revision}`).join('\n\n');
  return `关于「${name}」的稳定参考由 ${sources.length} 条独立记忆摘录而成。下面保留各条原文，没有另作改写。\n\n${body}`;
}

async function replaceEntityName(tx: KnowledgeDb, entity: { id: string; topicId: string | null; name: string }, next: string) {
  const memories = await tx.memory.findMany({ where: { topicId: entity.topicId } });
  const rewrites: Array<{ id: string; title: string; content: string; labels: string[]; toRevision: number }> = [];
  const timestamp = knowledgeNow();
  for (const memory of memories) {
    const labels = readLabels(memory.labels);
    const mentioned = memory.title.includes(`[[${entity.name}]]`) || memory.content.includes(`[[${entity.name}]]`);
    if (!labels.includes(entity.name) && !mentioned) continue;
    const nextLabels = labels.map((label) => label === entity.name ? next : label);
    const title = memory.title.split(`[[${entity.name}]]`).join(`[[${next}]]`);
    const content = memory.content.split(`[[${entity.name}]]`).join(`[[${next}]]`);
    const updated = await tx.memory.update({ where: { id: memory.id, revision: memory.revision }, data: { title, content, labels: JSON.stringify([...new Set(nextLabels)]), revision: { increment: 1 }, updatedAt: timestamp } });
    await tx.memoryVersion.create({ data: { memoryId: updated.id, revision: updated.revision, title: updated.title, content: updated.content, kind: updated.kind, status: updated.status, health: updated.health, evidence: updated.evidence, importance: updated.importance, labels: updated.labels, origin: updated.origin, reason: `本体更名：${entity.name} → ${next}`, createdAt: timestamp } });
    rewrites.push({ id: memory.id, title: memory.title, content: memory.content, labels, toRevision: updated.revision });
  }
  return rewrites;
}

export class KnowledgeGraph {
  async tree(actor: Actor, topicId: string | null) {
    await checkKnowledgeScope(prisma, actor, topicId);
    const [memories, materials, tasks] = await Promise.all([
      prisma.memory.findMany({ where: { topicId, status: 'active' }, orderBy: [{ importance: 'desc' }, { createdAt: 'desc' }] }),
      prisma.material.findMany({ where: { topicId, archivedAt: null, kind: 'thread' }, orderBy: { createdAt: 'desc' } }),
      prisma.task.findMany({ where: { topicId, deletedAt: null }, select: { id: true } }),
    ]);
    const handoffs = tasks.length ? await prisma.handoff.findMany({ where: { taskId: { in: tasks.map((task) => task.id) } }, include: { runs: { include: { artifacts: true } } } }) : [];
    const artifacts = handoffs.flatMap((handoff) => handoff.runs.flatMap((run) => run.artifacts));
    const versions = new Map<string, { content: string }>();
    for (const version of await prisma.materialVersion.findMany({ where: { materialId: { in: materials.map((item) => item.id) } }, orderBy: { revision: 'desc' } })) if (!versions.has(version.materialId)) versions.set(version.materialId, version);
    const entries = [
      ...memories.map((memory) => ({ id: memory.id, type: 'memory' as const, title: memory.title, excerpt: excerpt(memory.content, 160), kind: memory.kind, importance: memory.importance, labels: readLabels(memory.labels), origin: memory.origin, status: memory.status, revision: memory.revision, createdAt: memory.createdAt, updatedAt: memory.updatedAt, branchIds: ['memories', `kind:${memory.kind}`, `day:${dayKey(memory.createdAt)}`] })),
      ...materials.map((material) => ({ id: material.id, type: 'material' as const, title: material.title, excerpt: excerpt(versions.get(material.id)?.content ?? '', 160), kind: material.kind, revision: material.revision, createdAt: material.createdAt, updatedAt: material.updatedAt, branchIds: ['threads'] })),
      ...artifacts.map((artifact) => ({ id: artifact.id, type: 'artifact' as const, title: artifact.name, excerpt: excerpt(artifact.content ?? artifact.path ?? '', 160), kind: artifact.kind, createdAt: artifact.createdAt, branchIds: ['artifacts'] })),
    ];
    const kindNames: Record<string, string> = { fact: '事实', decision: '决策', constraint: '约束', learning: '经验', question: '未决问题', crystal: '结晶' };
    const kindCounts = new Map<string, number>();
    const dayCounts = new Map<string, number>();
    for (const memory of memories) { kindCounts.set(memory.kind, (kindCounts.get(memory.kind) ?? 0) + 1); const day = dayKey(memory.createdAt); dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1); }
    const branches = [
      { id: 'memories', label: '记忆', count: memories.length, children: [...kindCounts.entries()].map(([kind, count]) => ({ id: `kind:${kind}`, label: kindNames[kind] ?? kind, count })) },
      { id: 'occurred', label: '发生于', count: memories.length, children: [...dayCounts.entries()].sort(([left], [right]) => right.localeCompare(left)).map(([day, count]) => ({ id: `day:${day}`, label: dayLabel(day), count })) },
      { id: 'brief', label: '工作记忆', count: 1, children: [] },
      { id: 'threads', label: '会话', count: materials.length, children: [] },
      { id: 'artifacts', label: '产物', count: artifacts.length, children: [] },
    ];
    return { branches, entries };
  }

  async read(actor: Actor, input: { topicId: string | null; q?: string; mode?: 'fast' | 'smart'; range?: number; focusType?: NodeType; focusId?: string; includeHistory?: boolean }) {
    const query = graphQuery.parse(input);
    await checkKnowledgeScope(prisma, actor, input.topicId);
    const topicId = input.topicId;
    const [memories, materials, tasks, entities, links] = await Promise.all([
      prisma.memory.findMany({ where: { topicId, ...(query.includeHistory ? {} : { status: 'active' }) } }),
      prisma.material.findMany({ where: { topicId, ...(query.includeHistory ? {} : { archivedAt: null }) }, include: { versions: { orderBy: { revision: 'desc' }, take: 1 } } }),
      prisma.task.findMany({ where: { topicId, ...(query.includeHistory ? {} : { deletedAt: null }) } }),
      prisma.entity.findMany({ where: { topicId } }),
      prisma.graphLink.findMany({ where: { topicId } }),
    ]);
    const taskIds = new Set(tasks.map((task) => task.id));
    const handoffs = taskIds.size ? await prisma.handoff.findMany({ where: { taskId: { in: [...taskIds] } }, include: { runs: { include: { artifacts: true } } } }) : [];
    const artifacts = handoffs.flatMap((handoff) => handoff.runs.flatMap((run) => run.artifacts.map((artifact) => ({ artifact, taskId: handoff.taskId }))));
    const nodes = new Map<string, GraphNode & { text: string }>();
    const add = (node: GraphNode & { text: string }) => nodes.set(node.id, node);
    for (const memory of memories) add({ id: nodeKey('memory', memory.id), rawId: memory.id, type: 'memory', title: memory.title, kind: memory.kind, status: memory.status, excerpt: excerpt(memory.content), importance: memory.importance, labels: readLabels(memory.labels), origin: memory.origin, revision: memory.revision, createdAt: memory.createdAt, text: `${memory.title}\n${memory.content}\n${readLabels(memory.labels).join(' ')}` });
    for (const material of materials) { const content = material.versions[0]?.content ?? ''; add({ id: nodeKey('material', material.id), rawId: material.id, type: 'material', title: material.title, kind: material.kind, status: material.archivedAt ? 'archived' : 'active', excerpt: excerpt(content), revision: material.revision, createdAt: material.createdAt, text: `${material.title}\n${content}` }); }
    for (const task of tasks) add({ id: nodeKey('task', task.id), rawId: task.id, type: 'task', title: task.title, kind: task.status, status: task.deletedAt ? 'deleted' : task.status, excerpt: excerpt(`${task.description}\n${task.resultSummary}`), revision: task.revision, text: `${task.title}\n${task.description}\n${task.resultSummary}` });
    for (const item of artifacts) add({ id: nodeKey('artifact', item.artifact.id), rawId: item.artifact.id, type: 'artifact', title: item.artifact.name, kind: item.artifact.kind, excerpt: excerpt(item.artifact.content ?? item.artifact.path ?? ''), createdAt: item.artifact.createdAt, text: `${item.artifact.name}\n${item.artifact.content ?? ''}` });
    for (const entity of entities) add({ id: nodeKey('entity', entity.id), rawId: entity.id, type: 'entity', title: entity.name, kind: entity.kind, description: entity.description, excerpt: excerpt(entity.description), revision: entity.revision, text: `${entity.name}\n${entity.description}` });
    const edges: GraphEdge[] = [];
    const edgeKey = new Set<string>();
    const connect = (edge: GraphEdge) => { const key = `${edge.relation}:${edge.from}:${edge.to}`; if (edgeKey.has(key) || !nodes.has(edge.from) || !nodes.has(edge.to)) return; edgeKey.add(key); edges.push(edge); };
    for (const memory of memories) for (const ref of readEvidence(memory.evidence)) connect({ id: `${memory.kind === 'crystal' && ref.type === 'memory' ? 'crystallized_from' : 'evidence'}:${memory.id}:${ref.id}`, from: nodeKey('memory', memory.id), to: nodeKey(ref.type, ref.id), relation: memory.kind === 'crystal' && ref.type === 'memory' ? 'crystallized_from' : 'evidence', manual: false });
    for (const material of materials) if (material.taskId && taskIds.has(material.taskId)) connect({ id: `attached:${material.id}:${material.taskId}`, from: nodeKey('material', material.id), to: nodeKey('task', material.taskId), relation: 'attached', manual: false });
    for (const item of artifacts) connect({ id: `produced:${item.artifact.id}:${item.taskId}`, from: nodeKey('artifact', item.artifact.id), to: nodeKey('task', item.taskId), relation: 'produced', manual: false });
    for (const link of links) connect({ id: link.id, from: nodeKey(link.fromType, link.fromId), to: nodeKey(link.toType, link.toId), relation: link.relation, note: link.note, manual: !['label', 'mentions'].includes(link.relation) });
    const memoryCounts = new Map<string, number>();
    for (const edge of edges) {
      const [left, right] = [nodes.get(edge.from), nodes.get(edge.to)];
      if (left?.type === 'entity' && right?.type === 'memory') memoryCounts.set(left.id, (memoryCounts.get(left.id) ?? 0) + 1);
      if (right?.type === 'entity' && left?.type === 'memory') memoryCounts.set(right.id, (memoryCounts.get(right.id) ?? 0) + 1);
    }
    for (const [id, count] of memoryCounts) { const node = nodes.get(id); if (node) node.memoryCount = count; }
    const terms = normalize(query.q).split(' ').filter(Boolean);
    const matches = (node: GraphNode & { text: string }) => {
      const hay = normalize(query.mode === 'fast' ? `${node.title}\n${(node.labels ?? []).join(' ')}` : node.text);
      return terms.every((term) => hay.includes(term));
    };
    const focus = query.focusId && query.focusType ? nodeKey(query.focusType, query.focusId) : '';
    const seeds = [...nodes.values()].filter((node) => (terms.length && matches(node)) || node.id === focus).map((node) => node.id);
    let visible = new Set(nodes.keys());
    let truncated = false;
    if (terms.length || focus) {
      visible = new Set(seeds);
      let frontier = [...seeds];
      const neighbors = new Map<string, string[]>();
      for (const edge of edges) { neighbors.set(edge.from, [...(neighbors.get(edge.from) ?? []), edge.to]); neighbors.set(edge.to, [...(neighbors.get(edge.to) ?? []), edge.from]); }
      for (let hop = 0; hop < query.range; hop += 1) {
        const next: string[] = [];
        for (const id of frontier) for (const neighbor of neighbors.get(id) ?? []) if (!visible.has(neighbor)) { visible.add(neighbor); next.push(neighbor); }
        frontier = next;
      }
    }
    if (visible.size > 500) { truncated = true; visible = new Set([...visible].slice(0, 500)); }
    const kept = [...nodes.values()].filter((node) => visible.has(node.id)).map(({ text: _text, ...node }) => node);
    const keptIds = new Set(kept.map((node) => node.id));
    return { nodes: kept, edges: edges.filter((edge) => keptIds.has(edge.from) && keptIds.has(edge.to)), focusIds: seeds.filter((id) => keptIds.has(id)), truncated, mode: query.mode, range: query.range };
  }

  async answer(actor: Actor, input: { topicId: string | null; question: string; mode?: 'fast' | 'smart'; range?: number }, complete: (messages: Array<{ role: 'system' | 'user'; content: string }>) => Promise<string>) {
    const question = z.string().trim().min(1).max(1000).parse(input.question);
    const matched = await this.read(actor, { topicId: input.topicId, q: question, mode: input.mode ?? 'smart', range: input.range ?? 1 });
    const fallback = matched.nodes.length ? null : await this.read(actor, { topicId: input.topicId, q: '', mode: 'smart', range: 1 });
    const source = fallback ?? matched;
    const cited = (fallback ? source.nodes.filter((node) => node.type === 'memory').slice(0, 8) : source.nodes).slice(0, 16);
    const packet = cited.map((node) => `[${node.type}:${node.rawId}] ${node.title}\n${node.excerpt ?? node.description ?? ''}`).join('\n\n').slice(0, 12_000);
    const notice = fallback ? '问题没有直接命中标题、标签或正文，下面改为当前范围内重要度较高的记忆。' : undefined;
    try {
      const answer = await complete([{ role: 'system', content: '你只能根据给出的图谱节点回答。每条依据用 [type:id] 引用。材料不足以回答时直接说明，不要补充节点里没有的事实。' }, { role: 'user', content: `问题：${question}\n\n节点：\n${packet || '（没有节点）'}` }]);
      return { mode: 'model' as const, answer: answer.trim() || '模型没有返回可用回答。', notice, citations: cited, truncated: source.truncated };
    } catch (error) {
      return { mode: 'retrieval' as const, answer: null, notice: [notice, error instanceof Error ? error.message : '模型不可用，下面是检索到的依据。'].filter(Boolean).join(''), citations: cited, truncated: source.truncated };
    }
  }
}

async function undoGraphChange(tx: KnowledgeDb, actor: Actor, record: UndoRecord, _context: MutationContext) {
  assertOwner(actor);
  const before = record.beforeSnapshot ? JSON.parse(record.beforeSnapshot) : null;
  const after = record.afterSnapshot ? JSON.parse(record.afterSnapshot) : null;
  if (record.entityType === 'graphLink') {
    if (after && !before) { await tx.graphLink.deleteMany({ where: { id: after.id } }); return { id: after.id }; }
    if (before && !after) {
      if (await tx.graphLink.findUnique({ where: { id: before.id } })) throw knowledgeFailure('UNDO_CONFLICT', '关系已重新建立');
      return tx.graphLink.create({ data: before });
    }
    throw knowledgeFailure('UNDO_CONFLICT', '缺少可验证的关系版本');
  }
  const current = await tx.entity.findUnique({ where: { id: record.entityId } });
  if (!after && before) {
    if (current) throw knowledgeFailure('UNDO_CONFLICT', '实体已重新建立');
    return tx.entity.create({ data: before });
  }
  if (after && !before) {
    if (!current || current.revision !== after.revision) throw knowledgeFailure('UNDO_CONFLICT', '实体已有后续修改');
    const links = await tx.graphLink.count({ where: { OR: [{ fromType: 'entity', fromId: current.id }, { toType: 'entity', toId: current.id }] } });
    if (links) throw knowledgeFailure('UNDO_CONFLICT', '实体已被引用，不能撤销创建');
    await tx.entity.delete({ where: { id: current.id } });
    return { id: current.id };
  }
  if (!current || !after || current.revision !== after.revision) throw knowledgeFailure('UNDO_CONFLICT', '实体已有后续修改');
  const rewrites = Array.isArray(after.memoryRewrites) ? after.memoryRewrites as Array<{ id: string; title: string; content: string; labels: string[]; toRevision: number }> : [];
  for (const rewrite of rewrites) {
    const memory = await tx.memory.findUnique({ where: { id: rewrite.id } });
    if (!memory || memory.revision !== rewrite.toRevision) throw knowledgeFailure('UNDO_CONFLICT', '更名涉及的记忆已有后续修改');
  }
  const timestamp = knowledgeNow();
  const restored = await tx.entity.update({ where: { id: current.id, revision: current.revision }, data: { name: before.name, kind: before.kind, description: before.description, revision: { increment: 1 }, updatedAt: timestamp } });
  for (const rewrite of rewrites) {
    const memory = await tx.memory.update({ where: { id: rewrite.id, revision: rewrite.toRevision }, data: { title: rewrite.title, content: rewrite.content, labels: JSON.stringify(rewrite.labels), revision: { increment: 1 }, updatedAt: timestamp } });
    await tx.memoryVersion.create({ data: { memoryId: memory.id, revision: memory.revision, title: memory.title, content: memory.content, kind: memory.kind, status: memory.status, health: memory.health, evidence: memory.evidence, importance: memory.importance, labels: memory.labels, origin: memory.origin, reason: '撤销本体更名', createdAt: timestamp } });
    await syncLabelEntities(tx, { ...memory, labels: rewrite.labels });
  }
  return restored;
}

export function registerGraphCommands() {
  const graph = new KnowledgeGraph();
  registerCommandHandler('entity.create', { description: '在当前清单建立一个本体实体。同名实体不能重复。', inputSchema: jsonSchema(entitySchema), forceProposal: true, inspect: async (tx, actor, command) => { const data = entitySchema.parse(command.input); await checkKnowledgeScope(tx, actor, data.topicId, true); if (await tx.entity.findUnique({ where: { topicKey_name: { topicKey: data.topicId ?? '', name: data.name } } })) throw knowledgeFailure('ENTITY_NAME_TAKEN', '这个范围里已经有同名实体'); return { preconditions: { name: data.name }, preview: data }; }, execute: async (tx, actor, command, context) => { const data = entitySchema.parse(command.input); await checkKnowledgeScope(tx, actor, data.topicId, true); const timestamp = knowledgeNow(); const entity = await tx.entity.create({ data: { ...(context.entityId || command.entityId ? { id: context.entityId ?? command.entityId } : {}), topicKey: data.topicId ?? '', topicId: data.topicId, name: data.name, kind: data.kind, description: data.description, createdAt: timestamp, updatedAt: timestamp } }); await recordChange(tx, 'entity', entity.id, 'create', null, entity, context); return entity; } });
  registerCommandHandler('entity.update', { description: '修改实体名称、类别或说明。改名会同步标签和 [[名称]]，并保留记忆版本。', inputSchema: jsonSchema(entityUpdateSchema), forceProposal: true, inspect: async (tx, actor, command) => { const data = entityUpdateSchema.parse(command.input); const entity = await tx.entity.findUnique({ where: { id: command.targetId } }); if (!entity) throw knowledgeFailure('NOT_FOUND', '实体不存在', 404); await checkKnowledgeScope(tx, actor, entity.topicId, true); if (!command.expectedRevision || entity.revision !== command.expectedRevision) throw knowledgeFailure('VERSION_CONFLICT', '实体已经变化，请刷新后重试'); if (data.name && data.name !== entity.name && await tx.entity.findUnique({ where: { topicKey_name: { topicKey: entity.topicKey, name: data.name } } })) throw knowledgeFailure('ENTITY_NAME_TAKEN', '这个范围里已经有同名实体'); return { preconditions: { id: entity.id, revision: entity.revision }, preview: { ...data, previousName: entity.name } }; }, execute: async (tx, actor, command, context) => { const data = entityUpdateSchema.parse(command.input); const entity = await tx.entity.findUniqueOrThrow({ where: { id: command.targetId } }); const next = data.name ?? entity.name; const rewrites = next === entity.name ? [] : await replaceEntityName(tx, entity, next); const updated = await tx.entity.update({ where: { id: entity.id, revision: command.expectedRevision }, data: { name: next, kind: data.kind ?? entity.kind, description: data.description ?? entity.description, revision: { increment: 1 }, updatedAt: knowledgeNow() } }); for (const rewrite of rewrites) { const memory = await tx.memory.findUniqueOrThrow({ where: { id: rewrite.id } }); await syncLabelEntities(tx, { ...memory, labels: readLabels(memory.labels) }); } await recordChange(tx, 'entity', updated.id, 'update', entity, { ...updated, memoryRewrites: rewrites }, context); return { ...updated, memoryRewrites: rewrites }; } });
  registerCommandHandler('entity.delete', { description: '删除没有关系引用的实体。', inputSchema: jsonSchema(z.object({}).strict()), forceProposal: true, inspect: async (tx, actor, command) => { z.object({}).strict().parse(command.input ?? {}); const entity = await tx.entity.findUnique({ where: { id: command.targetId } }); if (!entity) throw knowledgeFailure('NOT_FOUND', '实体不存在', 404); await checkKnowledgeScope(tx, actor, entity.topicId, true); if (!command.expectedRevision || entity.revision !== command.expectedRevision) throw knowledgeFailure('VERSION_CONFLICT', '实体已经变化，请刷新后重试'); if (await tx.graphLink.count({ where: { OR: [{ fromType: 'entity', fromId: entity.id }, { toType: 'entity', toId: entity.id }] } })) throw knowledgeFailure('ENTITY_IN_USE', '仍有记忆或关系使用这个实体'); return { preconditions: { id: entity.id, revision: entity.revision }, preview: { name: entity.name } }; }, execute: async (tx, actor, command, context) => { const entity = await tx.entity.findUniqueOrThrow({ where: { id: command.targetId } }); const deleted = await tx.entity.deleteMany({ where: { id: entity.id, revision: command.expectedRevision } }); if (!deleted.count) throw knowledgeFailure('VERSION_CONFLICT', '实体已经变化，请刷新后重试'); await recordChange(tx, 'entity', entity.id, 'delete', entity, null, context); return { id: entity.id }; } });
  registerCommandHandler('graph.link', { description: '在两个已有节点之间建立 related、about 或 contrasts 关系。', inputSchema: jsonSchema(linkSchema), forceProposal: true, inspect: async (tx, actor, command) => { const data = linkSchema.parse(command.input); await checkKnowledgeScope(tx, actor, data.topicId, true); if (data.fromType === data.toType && data.fromId === data.toId) throw knowledgeFailure('INVALID_LINK', '不能把节点连到自己', 400); const from = await located(tx, data.fromType, data.fromId); const to = await located(tx, data.toType, data.toId); if (!from || !to || from.topicId !== data.topicId || to.topicId !== data.topicId) throw knowledgeFailure('SOURCE_SCOPE_MISMATCH', '关系两端必须属于当前清单', 403); if (await tx.graphLink.findFirst({ where: { fromType: data.fromType, fromId: data.fromId, toType: data.toType, toId: data.toId, relation: data.relation } })) throw knowledgeFailure('LINK_EXISTS', '这条关系已经存在'); return { preconditions: data, preview: { ...data, from: from.title, to: to.title } }; }, execute: async (tx, actor, command, context) => { const data = linkSchema.parse(command.input); const link = await tx.graphLink.create({ data: { ...(context.entityId || command.entityId ? { id: context.entityId ?? command.entityId } : {}), topicId: data.topicId, fromType: data.fromType, fromId: data.fromId, toType: data.toType, toId: data.toId, relation: data.relation, note: data.note, createdAt: knowledgeNow() } }); await recordChange(tx, 'graphLink', link.id, 'create', null, link, context); return link; } });
  registerCommandHandler('graph.unlink', { description: '移除一条手工关系。标签和证据关系要改记忆本身。', inputSchema: jsonSchema(z.object({}).strict()), forceProposal: true, inspect: async (tx, actor, command) => { z.object({}).strict().parse(command.input ?? {}); const link = await tx.graphLink.findUnique({ where: { id: command.targetId } }); if (!link) throw knowledgeFailure('NOT_FOUND', '关系不存在', 404); await checkKnowledgeScope(tx, actor, link.topicId, true); if (['label', 'mentions'].includes(link.relation)) throw knowledgeFailure('DERIVED_LINK', '标签和提及由记忆内容维护', 400); return { preconditions: { id: link.id }, preview: link }; }, execute: async (tx, actor, command, context) => { const link = await tx.graphLink.findUniqueOrThrow({ where: { id: command.targetId } }); await tx.graphLink.delete({ where: { id: link.id } }); await recordChange(tx, 'graphLink', link.id, 'delete', link, null, context); return { id: link.id }; } });
  registerCommandHandler('memory.crystallize', { description: '把同一实体下至少三条活跃记忆摘录成一条结晶记忆。证据由服务端固定，不能自行指定。', inputSchema: jsonSchema(crystalSchema), forceProposal: true, inspect: async (tx, actor, command) => { const data = crystalSchema.parse(command.input); const entity = await tx.entity.findUnique({ where: { id: data.entityId } }); if (!entity || entity.topicId !== data.topicId) throw knowledgeFailure('NOT_FOUND', '实体不存在', 404); await checkKnowledgeScope(tx, actor, data.topicId, true); const sources = await crystalSources(tx, entity); if (sources.length < 3) throw knowledgeFailure('CRYSTAL_SOURCES', '至少需要三条独立的活跃记忆才能沉淀', 400); return { preconditions: { entityId: entity.id, sources: sources.map((source) => ({ id: source.id, revision: source.revision })) }, preview: { title: data.title ?? `关于${entity.name}的稳定认识`, sourceCount: sources.length } }; }, execute: async (tx, actor, command, context) => {
    const data = crystalSchema.parse(command.input);
    const entity = await tx.entity.findUniqueOrThrow({ where: { id: data.entityId } });
    const sources = await crystalSources(tx, entity);
    if (sources.length < 3) throw knowledgeFailure('CRYSTAL_SOURCES', '至少需要三条独立的活跃记忆才能沉淀', 400);
    const evidence: EvidenceRef[] = sources.map((source) => ({ type: 'memory' as const, id: source.id, revision: source.revision, hash: knowledgeHash(source.content) }));
    if (!data.content) {
      const crystals = await tx.memory.findMany({ where: { topicId: data.topicId, status: 'active', kind: 'crystal' } });
      const existing = crystals.find((crystal) => { const refs = readEvidence(crystal.evidence).filter((ref) => ref.type === 'memory'); return refs.length === evidence.length && evidence.every((ref) => refs.some((item) => item.id === ref.id && item.revision === ref.revision)); });
      if (existing) return { ...existing, labels: readLabels(existing.labels), evidence: readEvidence(existing.evidence), reused: true };
    }
    return persistMemory(tx, actor, command, context, { existing: null, topicId: data.topicId, title: data.title ?? `关于${entity.name}的稳定认识`, content: data.content ?? compileCrystal(entity.name, sources), kind: 'crystal', status: 'active', evidence, reason: data.reason, importance: Math.max(3, ...sources.map((source) => source.importance)), labels: [entity.name], origin: memoryOrigin(actor) });
  } });
  registerUndoHandler('entity', undoGraphChange);
  registerUndoHandler('graphLink', undoGraphChange);
  return graph;
}
