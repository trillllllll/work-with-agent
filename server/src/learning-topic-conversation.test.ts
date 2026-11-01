import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentService, type ModelMessage } from './agent.js';
import { app } from './app.js';
import ownerRequest from './test-auth.js';
import { prisma } from './infrastructure/prisma.js';
import { CommandService } from './application/commands.js';
import { ownerActor } from './application/security.js';

const commands = new CommandService();
const createMap = async (title: string) => (await commands.submit(ownerActor, { requestId: randomUUID(), commands: [{ kind: 'learning.map.create', input: { title, goal: `${title} goal` } }] })).results[0];

function recording(script?: (messages: ModelMessage[]) => any) {
  const systems: string[] = [];
  const agent = new AgentService({ stream: async function* (messages: ModelMessage[]) {
    systems.push(String(messages[0].content));
    yield script?.(messages) ?? { text: 'ok' };
  } } as never);
  return { agent, systems };
}

describe('study conversations bound to a topic', () => {
  const clean = async () => {
    await prisma.conversation.updateMany({ data: { learningMapId: null } });
    await prisma.learningActivity.deleteMany(); await prisma.learningNode.deleteMany(); await prisma.learningMap.deleteMany();
  };
  beforeEach(clean);
  afterEach(clean);

  it('starts a new conversation on the chosen topic and names it in the system prompt', async () => {
    const js = await createMap('JavaScript 进阶');
    const { agent, systems } = recording();
    const result = await agent.chat({ identityId: 'study', message: '讲讲闭包', learningMapId: js.id, requestKey: randomUUID() });
    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: result.conversationId! } });
    expect(conversation.learningMapId).toBe(js.id);
    expect(systems[0]).toContain('【当前主题】');
    expect(systems[0]).toContain(`${js.id} JavaScript 进阶`);
    const snapshot = await ownerRequest(app).get(`/api/conversations/${conversation.id}/snapshot`);
    expect(snapshot.body.data.learningMapId).toBe(js.id);
  });

  it('switches, lists and clears the topic through PATCH and rejects work conversations and missing topics', async () => {
    const js = await createMap('JS'); const la = await createMap('LA');
    const { agent } = recording();
    const study = await agent.chat({ identityId: 'study', message: '你好', requestKey: randomUUID() });
    const work = await agent.chat({ identityId: 'work', message: '你好', requestKey: randomUUID() });
    let response = await ownerRequest(app).patch(`/api/conversations/${study.conversationId}`).send({ learningMapId: la.id });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toMatchObject({ learningMapId: la.id });
    const list = await ownerRequest(app).get(`/api/conversations?identityId=study&learningMapId=${la.id}`);
    expect(list.body.data.items.map((item: any) => item.id)).toEqual([study.conversationId]);
    expect((await ownerRequest(app).get(`/api/conversations?identityId=study&learningMapId=${js.id}`)).body.data.items).toEqual([]);
    response = await ownerRequest(app).patch(`/api/conversations/${work.conversationId}`).send({ learningMapId: js.id });
    expect(response.status).toBe(400);
    response = await ownerRequest(app).patch(`/api/conversations/${study.conversationId}`).send({ learningMapId: 'missing' });
    expect(response.status).toBe(404);
    response = await ownerRequest(app).patch(`/api/conversations/${study.conversationId}`).send({ learningMapId: null });
    expect(response.body.data.learningMapId).toBeNull();
    response = await ownerRequest(app).patch(`/api/conversations/${study.conversationId}`).send({ webSearchEnabled: true });
    expect(response.body.data).toMatchObject({ webSearchEnabled: true });
  });

  it('binds an unbound study conversation to the topic it creates once the proposal is approved', async () => {
    const { agent, systems } = recording(messages => {
      const tools = messages.filter(message => message.role === 'tool').map(message => String(message.content));
      if (!tools.some(content => content.includes('propose_changes'))) return { toolCalls: [{ id: randomUUID(), name: 'propose_changes', arguments: { summary: 'topic', operations: [{ family: 'learning', args: { action: 'map_create', title: '线性代数', goal: '' } }] } }] };
      return { text: 'ok' };
    });
    const response = await agent.chat({ identityId: 'study', message: '帮我新建主题线性代数', requestKey: randomUUID() });
    expect(systems[0]).toContain('还没有绑定主题');
    const event = response.events.find(item => item.type === 'approval_required') as any;
    expect(event, JSON.stringify(response.events.map(item => item.type))).toBeTruthy();
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: response.conversationId! } })).learningMapId).toBeNull();
    await agent.approve(event.approvalId, { expectedProposalRevision: event.proposalRevision, previewHash: event.previewHash });
    const map = await prisma.learningMap.findFirstOrThrow({ where: { title: '线性代数' } });
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: response.conversationId! } })).learningMapId).toBe(map.id);
  });
});
