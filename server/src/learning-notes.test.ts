import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentService, type ModelMessage } from './agent.js';
import { app } from './app.js';
import ownerRequest from './test-auth.js';
import { prisma } from './infrastructure/prisma.js';
import { CommandService } from './application/commands.js';
import { ownerActor } from './application/security.js';
import { learningRead } from './application/learning.js';
import { toolsForGroups } from './agent/tool-loading.js';
const commands = new CommandService();
const submit = (batch: unknown[], requestId = randomUUID()) => commands.submit(ownerActor, { requestId, commands: batch });
async function create() {
  const result = await submit([
    { kind: 'learning.map.create', clientRef: 'map', input: { title: 'Learning notes', goal: '' } },
    { kind: 'learning.node.create', clientRef: 'group', input: { mapId: { $ref: 'map' },parentId: null,kind: 'topic',title: 'Group',detail: '',sortOrder: 0 } },
    { kind: 'learning.node.create', input: { mapId: { $ref: 'map' },parentId: { $ref: 'group' },kind: 'item',title: 'Point',detail: '# Model\n\nInitial note',sortOrder: 0 } },
  ]);
  return { map: result.results[0],group: result.results[1],node: result.results[2] };
}
function proposing(operations: unknown[], readNodeId?: string) {
  return new AgentService({ stream: async function* (messages: ModelMessage[]) {
    const latest = messages.length - 1 - [...messages].reverse().findIndex(message => message.role === 'user');
    const results = messages.slice(latest + 1).filter(message => message.role === 'tool').map(message => String(message.content));
    if (readNodeId && !results.some(content => content.includes('learning_read'))) yield { toolCalls: [{ id: randomUUID(),name: 'learning_read',arguments: { action: 'node',nodeId: readNodeId } }] };
    else if (!results.some(content => content.includes('propose_changes'))) yield { toolCalls: [{ id: randomUUID(),name: 'propose_changes',arguments: { summary: 'Update learning notes', operations } }] };
    else yield { text: 'Ready.' };
  } } as never);
}
async function proposal(agent: AgentService, context?: unknown) {
  const response = await agent.chat({ identityId: 'study',message: '维护知识笔记和掌握情况',requestKey: randomUUID(), ...(context ? { context } : {}) } as Parameters<AgentService['chat']>[0]);
  const event = response.events.find(event => event.type === 'approval_required') as any;
  expect(event,JSON.stringify(response.events)).toBeTruthy();
  return { event,response,approve: () => agent.approve(event.approvalId, { expectedProposalRevision: event.proposalRevision, previewHash: event.previewHash }) as Promise<any> };
}
describe('persistent learning notes and AI CRUD', () => {
  const clean = async () => { await prisma.learningActivity.deleteMany(); await prisma.learningNode.updateMany({ data: { parentId: null } }); await prisma.learningNode.deleteMany(); await prisma.learningMap.deleteMany(); };
  beforeEach(clean);
  afterEach(clean);
  it('persists manual edits through authenticated commands, accepts four explicit states and rejects stale writes', async () => {
    const { map,node } = await create();
    let revision = node.revision;
    for (const status of ['todo','learning','review','done']) {
      const response = await ownerRequest(app).post('/api/v1/commands').send({ requestId: randomUUID(),commands: [{ kind: 'learning.node.update',targetId: node.id,expectedRevision: revision,input: { status } }] });
      expect(response.status,JSON.stringify(response.body)).toBe(200);
      expect(response.body.data.results[0]).toMatchObject({ status,detail: '# Model\n\nInitial note' });
      revision++;
    }
    const requestId = randomUUID();
    const update = [{ kind: 'learning.node.update',targetId: node.id,expectedRevision: revision,input: { detail: 'A durable **model**' } }];
    await submit(update,requestId); await submit(update,requestId);
    expect(await prisma.learningNode.findUniqueOrThrow({ where: { id: node.id } })).toMatchObject({ revision: revision+1,status: 'done',detail: 'A durable **model**' });
    await expect(submit([{ ...update[0],input: { detail: 'stale overwrite' } }])).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const response = await ownerRequest(app).get(`/api/v1/learning/maps/${map.id}`);
    expect(JSON.stringify(response.body.data.tree)).toContain('A durable **model**');
  });
  it('creates a real topic, nested structure and initial note in one AI proposal without changing data before approval', async () => {
    const agent = proposing([
      { family: 'learning',clientRef: 'map',args: { action: 'map_create',title: 'Pulsar',goal: 'Build a model' } },
      { family: 'learning',clientRef: 'group',args: { action: 'node_create',mapId: { $ref: 'map' },parentId: null,kind: 'topic',title: 'Storage' } },
      { family: 'learning',args: { action: 'node_create',mapId: { $ref: 'map' },parentId: { $ref: 'group' },kind: 'item',title: 'Ledger',detail: 'A persistent note',nodeStatus: 'review' } },
    ]);
    const pending = await proposal(agent);
    expect(await prisma.learningMap.count()).toBe(0);
    expect((await pending.approve()).outcome.status).toBe('executed');
    const map = await prisma.learningMap.findFirstOrThrow({ where: { title: 'Pulsar' } });
    const group = await prisma.learningNode.findFirstOrThrow({ where: { mapId: map.id,kind: 'topic' } });
    expect(await prisma.learningNode.findFirstOrThrow({ where: { parentId: group.id } })).toMatchObject({ detail: 'A persistent note',status: 'review' });
    const tool = toolsForGroups(['learning_write'],false,'study').find(tool => tool.function.name === 'propose_changes')!;
    expect(JSON.stringify(tool.function.parameters)).toContain('"$ref"');
    expect(JSON.stringify(tool.function.parameters)).toContain('review');
  });
  it('replays explicitly attached note identity, reads real content, then edits only after approval; old proposals cannot overwrite human edits', async () => {
    const { map,node } = await create();
    const agent = proposing([{ family: 'learning',args: { action: 'node_update',nodeId: node.id,expectedNodeRevision: node.revision,detail: 'AI revised note',nodeStatus: 'review' } }],node.id);
    const context = { schemaVersion: 3,page: 'learning',scope: { kind: 'all' },taskId: null,materialId: null,selectedTaskIds: [],taskFilter: null,timeZone: 'Asia/Shanghai',referencedApprovalId: null,label: 'Learning',section: null,mode: 'follow',taskRevision: null,materialRevision: null,selectedMaterialIds: [],pageState: {},identityId: 'study',attachments: [{ id: 'note-ref',kind: 'draft',title: node.title,text: 'Local draft',unsaved: true,learningMapId: map.id,learningNodeId: node.id,learningRevision: node.revision }] };
    const first = await proposal(agent,context);
    expect(first.response.events.find(event => event.type === 'tool_result' && event.toolName === 'learning_read')).toMatchObject({ result: { success: true } });
    expect(await prisma.learningNode.findUniqueOrThrow({ where: { id: node.id } })).toMatchObject({ detail: node.detail });
    const run = await prisma.agentRun.findFirstOrThrow({ where: { conversationId: first.response.conversationId } });
    expect(JSON.parse(run.contextJson).attachments[0]).toMatchObject({ learningNodeId: node.id,learningRevision: 1,unsaved: true });
    expect((await first.approve()).outcome.status).toBe('executed');
    const next = await prisma.learningNode.findUniqueOrThrow({ where: { id: node.id } });
    expect(next).toMatchObject({ detail: 'AI revised note',status: 'review',revision: 2 });
    const stale = await proposal(proposing([{ family: 'learning',args: { action: 'node_update',nodeId: node.id,expectedNodeRevision: next.revision,detail: 'Old AI text' } }]));
    await submit([{ kind: 'learning.node.update',targetId: node.id,expectedRevision: next.revision,input: { detail: 'Human text' } }]);
    expect((await stale.approve()).outcome.status).not.toBe('executed');
    expect((await prisma.learningNode.findUniqueOrThrow({ where: { id: node.id } })).detail).toBe('Human text');
  });
  it('shows every affected note in map deletion approval and protects the scope from later edits', async () => {
    const { map,node } = await create();
    const pending = await proposal(proposing([{ family: 'learning',args: { action: 'map_archive',mapId: map.id,expectedRevision: 1 } }]));
    expect(pending.event.review.affectedEntityCount).toBe(3);
    expect(pending.event.review.entities.map((entity: { entityType: string }) => entity.entityType)).toEqual(expect.arrayContaining(['learning_map','learning_node','learning_node']));
    expect(JSON.stringify(pending.event.review.consequences)).toContain('3 个对象');
    await submit([{ kind: 'learning.node.update',targetId: node.id,expectedRevision: 1,input: { detail: 'New note' } }]);
    expect((await pending.approve()).outcome.status).not.toBe('executed');
    const next = await proposal(proposing([{ family: 'learning',args: { action: 'map_archive',mapId: map.id,expectedRevision: 1 } }]));
    expect((await next.approve()).outcome.status).toBe('executed');
    expect(await prisma.learningNode.count({ where: { mapId: map.id,deletedAt: null } })).toBe(0);
  });
  it('freezes cascade deletion scope and prevents archived maps being read or edited accidentally', async () => {
    const { map,group,node } = await create();
    const pending = await proposal(proposing([{ family: 'learning',args: { action: 'node_archive',nodeId: group.id,expectedNodeRevision: 1,cascade: true } }]));
    await submit([{ kind: 'learning.node.update',targetId: node.id,expectedRevision: 1,input: { detail: 'A new human note' } }]);
    expect((await pending.approve()).outcome.status).not.toBe('executed');
    expect((await prisma.learningNode.findUniqueOrThrow({ where: { id: node.id } })).deletedAt).toBeNull();
    await expect(submit([{ kind: 'learning.node.archive',targetId: group.id,expectedRevision: 1,input: {} }])).rejects.toMatchObject({ code: 'NODE_HAS_CHILDREN' });
    const deletion = await proposal(proposing([{ family: 'learning',args: { action: 'node_archive',nodeId: group.id,expectedNodeRevision: 1,cascade: true,expectedDescendantRevisions: { [node.id]: 2 } } }]));
    expect((await deletion.approve()).outcome.status).toBe('executed');
    expect(await prisma.learningNode.count({ where: { mapId: map.id,deletedAt: null } })).toBe(0);
    await submit([{ kind: 'learning.map.archive',targetId: map.id,expectedRevision: 1,input: { expectedNodeRevisions: {} } }]);
    await expect(learningRead({ action: 'get',mapId: map.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(submit([{ kind: 'learning.node.create',input: { mapId: map.id,parentId: null,kind: 'item',title: 'Hidden',detail: '',sortOrder: 0 } }])).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
