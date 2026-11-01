import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { app } from './app.js';
import ownerRequest from './test-auth.js';
import { prisma } from './infrastructure/prisma.js';
import { CommandService } from './application/commands.js';
import { ownerActor } from './application/security.js';
import { buildReview } from './agent/review.js';
import { AgentService, type ModelMessage } from './agent.js';
import { validateLearningArguments } from './application/agent-learning.js';

function proposing(operations: unknown[]) {
  return new AgentService({ stream: async function* (messages: ModelMessage[]) {
    const latest = messages.length - 1 - [...messages].reverse().findIndex(message => message.role === 'user');
    const results = messages.slice(latest + 1).filter(message => message.role === 'tool').map(message => String(message.content));
    if (!results.some(content => content.includes('propose_changes'))) yield { toolCalls: [{ id: randomUUID(), name: 'propose_changes', arguments: { summary: 'New topic with figure', operations } }] };
    else yield { text: 'Ready.' };
  } } as never);
}

const commands = new CommandService();
const submit = (batch: unknown[], requestId = randomUUID()) => commands.submit(ownerActor, { requestId, commands: batch });
const box = (id: string) => `<g data-node-id="${id}"><rect x="0" y="0" width="80" height="30" fill="#ffffff"/><text x="8" y="20">${id}</text></g>`;
const svg = (...ids: string[]) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200">${ids.map(box).join('')}</svg>`;

async function topic() {
  const result = await submit([
    { kind: 'learning.map.create', clientRef: 'map', input: { title: 'Figures', goal: '' } },
    { kind: 'learning.node.create', clientRef: 'group', input: { mapId: { $ref: 'map' }, parentId: null, kind: 'topic', title: 'Group', detail: '', sortOrder: 0 } },
    { kind: 'learning.node.create', input: { mapId: { $ref: 'map' }, parentId: { $ref: 'group' }, kind: 'item', title: 'A', detail: '', sortOrder: 0 } },
    { kind: 'learning.node.create', input: { mapId: { $ref: 'map' }, parentId: { $ref: 'group' }, kind: 'item', title: 'B', detail: '', sortOrder: 1 } },
  ]);
  return { map: result.results[0], group: result.results[1], a: result.results[2], b: result.results[3] };
}

describe('learning figure (学习主图)', () => {
  const clean = async () => { await prisma.learningFigure.deleteMany(); await prisma.learningActivity.deleteMany(); await prisma.learningNode.updateMany({ data: { parentId: null } }); await prisma.learningNode.deleteMany(); await prisma.learningMap.deleteMany(); };
  beforeEach(clean);
  afterEach(clean);

  it('saves a sanitized figure, records the tagged items and reports staleness after the topic changes', async () => {
    const { map, a, b, group } = await topic();
    const saved = (await submit([{ kind: 'learning.figure.save', input: { mapId: map.id, svg: svg(a.id) } }])).results[0];
    expect(saved).toMatchObject({ mapId: map.id, revision: 1 });
    expect(JSON.parse(saved.nodeIdsJson)).toEqual([a.id]);
    let read = await ownerRequest(app).get(`/api/v1/learning/maps/${map.id}`);
    expect(read.body.data.figure).toMatchObject({ revision: 1, stale: true, missingNodeIds: [b.id], removedNodeIds: [] });
    expect(read.body.data.figure.svg).toContain(`data-node-id="${a.id}"`);

    await submit([{ kind: 'learning.figure.save', expectedRevision: 1, input: { mapId: map.id, svg: svg(a.id, b.id) } }]);
    read = await ownerRequest(app).get(`/api/v1/learning/maps/${map.id}`);
    expect(read.body.data.figure).toMatchObject({ revision: 2, stale: false, missingNodeIds: [] });

    const node = await prisma.learningNode.findUniqueOrThrow({ where: { id: b.id } });
    await submit([{ kind: 'learning.node.archive', targetId: b.id, expectedRevision: node.revision, input: {} }]);
    read = await ownerRequest(app).get(`/api/v1/learning/maps/${map.id}`);
    expect(read.body.data.figure).toMatchObject({ stale: true, removedNodeIds: [b.id] });
    await submit([{ kind: 'learning.node.create', input: { mapId: map.id, parentId: group.id, kind: 'item', title: 'C', detail: '', sortOrder: 2 } }]);
    read = await ownerRequest(app).get(`/api/v1/learning/maps/${map.id}`);
    expect(read.body.data.figure.missingNodeIds).toHaveLength(1);
  });

  it('rejects scripts, events, links and tags that point outside the topic', async () => {
    const { map, a, group } = await topic();
    const other = (await submit([
      { kind: 'learning.map.create', clientRef: 'other', input: { title: 'Other', goal: '' } },
      { kind: 'learning.node.create', input: { mapId: { $ref: 'other' }, parentId: null, kind: 'item', title: 'X', detail: '', sortOrder: 0 } },
    ])).results[1];
    const save = (source: string) => submit([{ kind: 'learning.figure.save', input: { mapId: map.id, svg: source } }]);
    await expect(save(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script>${box(a.id)}</svg>`)).rejects.toMatchObject({ code: 'INVALID_FIGURE' });
    await expect(save(`<svg xmlns="http://www.w3.org/2000/svg"><g data-node-id="${a.id}" onclick="alert(1)"><rect width="9" height="9"/></g></svg>`)).rejects.toMatchObject({ code: 'INVALID_FIGURE' });
    await expect(save(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><a href="https://example.com">${box(a.id)}</a></svg>`)).rejects.toMatchObject({ code: 'INVALID_FIGURE' });
    await expect(save(svg(other.id))).rejects.toMatchObject({ code: 'INVALID_FIGURE_NODE' });
    await expect(save(svg(group.id))).rejects.toMatchObject({ code: 'INVALID_FIGURE_NODE' });
    await expect(save('<svg xmlns="http://www.w3.org/2000/svg"><rect width="9" height="9"/></svg>')).rejects.toMatchObject({ code: 'INVALID_FIGURE' });
    expect(await prisma.learningFigure.count()).toBe(0);
  });

  it('invalidates a figure after a move or rename, but not a mastery change, and rejects approval against an old structure', async () => {
    const { map, a, b } = await topic();
    await submit([{ kind: 'learning.figure.save', input: { mapId: map.id, svg: svg(a.id, b.id) } }]);
    await submit([{ kind: 'learning.node.update', targetId: a.id, expectedRevision: 1, input: { status: 'learning' } }]);
    expect((await ownerRequest(app).get(`/api/v1/learning/maps/${map.id}`)).body.data.figure.stale).toBe(false);
    const agent = proposing([{ family: 'learning', args: { action: 'figure_save', mapId: map.id, svg: svg(a.id, b.id).replace('400 200', '420 200'), expectedFigureRevision: 1 } }]);
    const response = await agent.chat({ identityId: 'study', message: '更新主图', requestKey: randomUUID() });
    const event = response.events.find(item => item.type === 'approval_required') as any;
    expect(event, JSON.stringify(response.events)).toBeTruthy();
    await submit([{ kind: 'learning.node.move', targetId: a.id, expectedRevision: 2, input: { parentId: null } }]);
    expect((await ownerRequest(app).get(`/api/v1/learning/maps/${map.id}`)).body.data.figure.stale).toBe(true);
    expect((await agent.approve(event.approvalId, { expectedProposalRevision: event.proposalRevision, previewHash: event.previewHash })).outcome).toMatchObject({ status: 'failed', code: 'VERSION_CONFLICT', appliedOperationCount: 0 });
    expect((await prisma.learningFigure.findUniqueOrThrow({where:{mapId:map.id}})).revision).toBe(1);
    await submit([{ kind: 'learning.figure.save', expectedRevision: 1, input: { mapId: map.id, svg: svg(a.id, b.id) } }]);
    await submit([{ kind: 'learning.node.update', targetId: a.id, expectedRevision: 3, input: { title: 'Renamed' } }]);
    expect((await ownerRequest(app).get(`/api/v1/learning/maps/${map.id}`)).body.data.figure.stale).toBe(true);
  });

  it('links placeholder names to items created in the same batch and guards the figure revision', async () => {
    const result = await submit([
      { kind: 'learning.map.create', clientRef: 'map', input: { title: 'Batch', goal: '' } },
      { kind: 'learning.node.create', clientRef: 'closure', input: { mapId: { $ref: 'map' }, parentId: null, kind: 'item', title: 'Closure', detail: '', sortOrder: 0 } },
      { kind: 'learning.figure.save', input: { mapId: { $ref: 'map' }, svg: svg('n-closure'), nodeRefs: { 'n-closure': { $ref: 'closure' } } } },
    ]);
    const [map, node, figure] = result.results;
    expect(figure.svg).toContain(`data-node-id="${node.id}"`);
    expect(figure.svg).not.toContain('data-node-id="n-closure"');
    await expect(submit([{ kind: 'learning.figure.save', input: { mapId: map.id, svg: svg(node.id) } }])).rejects.toMatchObject({ code: 'VERSION_REQUIRED' });
    await expect(submit([{ kind: 'learning.figure.save', expectedRevision: 5, input: { mapId: map.id, svg: svg(node.id) } }])).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const change = await prisma.changeRecord.findFirstOrThrow({ where: { entityType: 'learning_figure' } });
    const review = buildReview({ intent: 'figure', requestedOperationCount: 1, commandCount: 1, explicitIds: [figure.id], records: [change] });
    expect(review.entities[0]).toMatchObject({ entityType: 'learning_figure', operation: 'create', fields: [{ key: 'svg', afterText: '1 个知识点' }] });
    expect(review.consequences.join('')).toContain('学习主图');
  });

  it('validates figure_save arguments before a proposal is created', () => {
    expect(validateLearningArguments({ action: 'figure_save', mapId: 'm', svg: svg('n1') })).toBeNull();
    expect(validateLearningArguments({ action: 'figure_save', mapId: 'm', svg: '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>' })).toContain('安全规则');
    expect(validateLearningArguments({ action: 'figure_save', mapId: 'm', svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>' })).toContain('data-node-id');
    expect(validateLearningArguments({ action: 'figure_save', mapId: 'm', svg: svg('n1'), nodeRefs: { n1: 3 } })).toContain('nodeRefs');
    expect(validateLearningArguments({ action: 'figure_save', mapId: 'm', svg: svg('n1'), expectedFigureRevision: 0 })).toContain('expectedFigureRevision');
  });

  it('proposes a topic, its knowledge points and the figure atomically and saves nothing before approval', async () => {
    const agent = proposing([
      { family: 'learning', clientRef: 'map', args: { action: 'map_create', title: 'JS 进阶', goal: '看懂源码' } },
      { family: 'learning', clientRef: 'closure', args: { action: 'node_create', mapId: { $ref: 'map' }, parentId: null, kind: 'item', title: '闭包' } },
      { family: 'learning', args: { action: 'figure_save', mapId: { $ref: 'map' }, svg: svg('p-closure'), nodeRefs: { 'p-closure': { $ref: 'closure' } } } },
    ]);
    const response = await agent.chat({ identityId: 'study', message: '帮我把 JS 整理成学习地图', requestKey: randomUUID() } as Parameters<AgentService['chat']>[0]);
    const event = response.events.find(item => item.type === 'approval_required') as any;
    expect(event, JSON.stringify(response.events)).toBeTruthy();
    expect(event.review.entities.map((entity: any) => entity.entityType)).toEqual(expect.arrayContaining(['learning_map', 'learning_node', 'learning_figure']));
    expect(event.review.entities.find((entity: any) => entity.entityType === 'learning_figure').fields[0].after).toContain('data-node-id');
    expect(await prisma.learningFigure.count()).toBe(0);
    await agent.approve(event.approvalId, { expectedProposalRevision: event.proposalRevision, previewHash: event.previewHash });
    const figure = await prisma.learningFigure.findFirstOrThrow();
    const node = await prisma.learningNode.findFirstOrThrow({ where: { title: '闭包' } });
    expect(figure.svg).toContain(`data-node-id="${node.id}"`);
  });
});
