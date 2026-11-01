import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentService, type ModelMessage } from './agent.js';
import { prisma } from './infrastructure/prisma.js';
import { CommandService } from './application/commands.js';
import { ownerActor } from './application/security.js';
import ownerRequest from './test-auth.js';
import { app } from './app.js';

const commands = new CommandService();
const maps: string[] = [];
async function seed() {
  const result = await commands.submit(ownerActor, { requestId: randomUUID(), commands: [
    { kind: 'learning.map.create', clientRef: 'map', input: { title: 'Chat learning', goal: '' } },
    { kind: 'learning.node.create', input: { mapId: { $ref: 'map' }, parentId: null, kind: 'item', title: 'Closure', detail: '', sortOrder: 0 } },
  ] });
  maps.push(result.results[0].id);
  return { mapId: result.results[0].id as string, nodeId: result.results[1].id as string };
}
async function card(args: Record<string, unknown>, mapId?: string, identityId = 'study', duplicate = false) {
  const callId = randomUUID();
  const agent = new AgentService({ stream: async function* (messages: ModelMessage[]) {
    if (messages.some(message => message.role === 'tool')) { yield { text: 'Ready.' }; return; }
    const call = { id: callId, name: 'show_learning_card', arguments: args };
    yield { toolCalls: duplicate ? [call, call] : [call] };
  } } as never);
  const result = await agent.chat({ identityId, learningMapId: mapId, message: '展示学习卡片', requestKey: randomUUID() });
  return { agent, result, parts: result.events.filter(event => event.type === 'external_prompt').map(event => event.part as Record<string, unknown>) };
}
afterEach(async () => {
  await prisma.learningActivity.deleteMany({ where: { mapId: { in: maps } } });
  await prisma.learningNode.deleteMany({ where: { mapId: { in: maps } } });
  await prisma.learningMap.deleteMany({ where: { id: { in: maps } } }); maps.length = 0;
});

describe('native learning cards', () => {
  it('persists a real node card once, streams it and restores the same card from a snapshot', async () => {
    const { mapId, nodeId } = await seed();
    const { agent, result, parts } = await card({ kind: 'node', nodeId }, mapId, 'study', true);
    expect(parts[0]).toMatchObject({ type: 'learning_card', kind: 'node', mapId, nodeId, title: 'Closure' });
    const snapshot = await agent.snapshot(result.conversationId!);
    const stored = snapshot.messages.flatMap(message => JSON.parse(message.partsJson || '[]')).filter(part => part.type === 'learning_card');
    expect(stored).toEqual([parts[0]]);
    expect(await prisma.learningAttempt.count()).toBe(0);
    expect(snapshot.learningMapId).toBe(mapId);
  });
  it('uses the bound topic for a figure and rejects a foreign node/topic pair or extra authority fields', async () => {
    const first = await seed(), second = await seed();
    expect((await card({ kind: 'figure' }, first.mapId)).parts[0]).toMatchObject({ kind: 'figure', mapId: first.mapId });
    for (const args of [{ kind: 'node', nodeId: first.nodeId, mapId: second.mapId }, { kind: 'node', nodeId: 'missing' }, { kind: 'practice' }, { kind: 'figure', score: 100 }]) {
      expect((await card(args, first.mapId)).parts).toEqual([]);
    }
    expect((await card({ kind: 'node', nodeId: first.nodeId }, undefined, 'work')).parts).toEqual([]);
  });
  it('shows a generated job without leaking private candidate answers or adopting it', async () => {
    const { mapId } = await seed();
    const job = await prisma.learningJob.create({ data: { ownerId: ownerActor.id, kind: 'generate', mapId, state: 'succeeded', inputJson: '{}', outputJson: '{"answer":"private-answer"}', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
    const { parts } = await card({ kind: 'practice', jobId: job.id }, mapId);
    expect(parts[0]).toMatchObject({ kind: 'practice', jobId: job.id, mapId });
    expect(JSON.stringify(parts)).not.toContain('private-answer');
    expect((await prisma.learningJob.findUniqueOrThrow({ where: { id: job.id } })).adoptedSessionId).toBeNull();
    await prisma.learningJob.delete({ where: { id: job.id } });
  });
  it('keeps the briefing scoped, empty when there are no facts and never invents a checkpoint', async () => {
    const first = await seed(), second = await seed();
    await commands.submit(ownerActor, { requestId: randomUUID(), commands: [{ kind: 'learning.activity.append', input: { mapId: second.mapId, nodeId: second.nodeId, kind: 'note', content: 'other-topic-private-note' } }] });
    const response = await ownerRequest(app).get(`/api/v1/learning/maps/${first.mapId}/briefing`);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ map: { id: first.mapId }, checkpoint: null, attempts: [], reviews: [], sessions: [] });
    expect(JSON.stringify(response.body)).not.toContain('other-topic-private-note');
    expect((await ownerRequest(app).get('/api/v1/learning/maps/missing/briefing')).status).toBe(404);
  });
});
