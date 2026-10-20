import { afterEach, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { app } from '../app.js';
import { prisma } from '../infrastructure/prisma.js';
import ownerRequest from '../test-auth.js';
import { setSkillDraftModel } from './skills.js';

const api = ownerRequest(app);
let seq = 0;
const stamp = () => `技能接口-${Date.now()}-${seq += 1}`;
const conversations: string[] = [];

async function clean() {
  setSkillDraftModel(null);
  await prisma.skillVersion.deleteMany();
  await prisma.skill.deleteMany();
  if (!conversations.length) return;
  await prisma.message.deleteMany({ where: { conversationId: { in: conversations } } });
  await prisma.conversation.deleteMany({ where: { id: { in: conversations } } });
  conversations.length = 0;
}

describe('skills REST API', () => {
  afterEach(clean);

  it('creates, lists without the body, versions, diffs, and soft-deletes through the owner API', async () => {
    const name = stamp();
    const created = await api.post('/api/skills').send({ name, description: '描述', instructions: '第一行\n第二行', reason: '手写' });
    expect(created.status).toBe(201);
    expect(created.body.error).toBeNull();
    expect(created.body.data).toMatchObject({ name, description: '描述', instructions: '第一行\n第二行', enabled: false, revision: 1, origin: 'manual', deletedAt: null });
    expect(created.body.data.versions).toEqual([expect.objectContaining({ revision: 1, reason: '手写', source: 'manual' })]);
    expect(created.body.data).not.toHaveProperty('versions.instructions');
    const id = created.body.data.id as string;

    const listed = await api.get('/api/skills').query({ q: name, enabled: 'false', origin: 'manual' });
    expect(listed.status).toBe(200);
    expect(listed.body.data).toEqual([expect.objectContaining({ id, name, description: '描述' })]);
    expect(listed.body.data[0]).not.toHaveProperty('instructions');

    const renamed = await api.patch(`/api/skills/${id}`).send({ expectedRevision: 1, instructions: '第二行\n第三行', enabled: true });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data.revision).toBe(2);
    expect(renamed.body.data.versions.map((version: { reason: string }) => version.reason)).toEqual(['手写', '修改']);

    const stale = await api.patch(`/api/skills/${id}`).send({ expectedRevision: 1, description: '过期窗口' });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'VERSION_CONFLICT', error: '内容已经变化，请刷新后重试', details: { currentRevision: 2 } });
    expect((await prisma.skill.findUniqueOrThrow({ where: { id } })).description).toBe('描述');

    const version = await api.get(`/api/skills/${id}/versions/1`);
    expect(version.status).toBe(200);
    expect(version.body.data).toMatchObject({ revision: 1, instructions: '第一行\n第二行', source: 'manual' });
    const diff = await api.get(`/api/skills/${id}/diff`).query({ from: 1, to: 2 });
    expect(diff.body.data.fields).toEqual([
      { key: 'instructions', before: '第一行\n第二行', after: '第二行\n第三行' },
      { key: 'enabled', before: false, after: true },
    ]);
    expect(diff.body.data.lines).toEqual([
      { type: 'remove', text: '第一行' },
      { type: 'same', text: '第二行' },
      { type: 'add', text: '第三行' },
    ]);

    const rolled = await api.post(`/api/skills/${id}/rollback`).send({ expectedRevision: 2, targetRevision: 1 });
    expect(rolled.status).toBe(200);
    expect(rolled.body.data).toMatchObject({ revision: 3, instructions: '第一行\n第二行', enabled: false });
    expect(rolled.body.data.versions.at(-1)).toMatchObject({ reason: '回滚到 v1', source: 'rollback' });

    const removed = await api.delete(`/api/skills/${id}`).query({ expectedRevision: 3 });
    expect(removed.status).toBe(200);
    expect(removed.body.data.deletedAt).toBeTruthy();
    expect(removed.body.data.enabled).toBe(false);
    expect((await api.get('/api/skills')).body.data.map((item: { id: string }) => item.id)).not.toContain(id);
    expect((await api.get('/api/skills').query({ deleted: 'true' })).body.data.map((item: { id: string }) => item.id)).toContain(id);
    expect((await api.get(`/api/skills/${id}/versions/1`)).body.data.instructions).toBe('第一行\n第二行');

    const reused = await api.post('/api/skills').send({ name, description: '占用', instructions: '占用正文' });
    expect(reused.status).toBe(201);
    const blocked = await api.post(`/api/skills/${id}/restore`);
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({ code: 'SKILL_NAME_TAKEN', details: { skillId: reused.body.data.id } });
    expect((await prisma.skill.findUniqueOrThrow({ where: { id } })).deletedAt).toBeTruthy();
    await api.delete(`/api/skills/${reused.body.data.id}`).query({ expectedRevision: 1 });
    const restored = await api.post(`/api/skills/${id}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.body.data).toMatchObject({ deletedAt: null, enabled: false, revision: 3, instructions: '第一行\n第二行' });
    expect(restored.body.data.versions).toHaveLength(3);
  });

  it('imports SKILL.md, refuses an unresolved clash, and drafts without persisting', async () => {
    const name = stamp();
    const markdown = `---\nname: ${name}\ndescription: 导入描述\nlicense: MIT\n---\n导入正文\n`;
    const missing = await api.post('/api/skills/import').send({ markdown: '# 没有头' });
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ code: 'SKILL_MARKDOWN_INVALID', details: { missing: ['frontmatter', 'name', 'description', '正文'] } });
    expect(await prisma.skill.count()).toBe(0);

    const imported = await api.post('/api/skills/import').send({ markdown });
    expect(imported.status).toBe(201);
    expect(imported.body.data).toMatchObject({ origin: 'import', instructions: '导入正文', revision: 1 });
    const clash = await api.post('/api/skills/import').send({ markdown });
    expect(clash.status).toBe(409);
    expect(clash.body).toMatchObject({ code: 'SKILL_NAME_TAKEN', details: { draft: { name, description: '导入描述', instructions: '导入正文' } } });
    expect(await prisma.skillVersion.count({ where: { skillId: imported.body.data.id } })).toBe(1);

    const covered = await api.post('/api/skills/import').send({ markdown: `---\nname: ${name}\ndescription: 覆盖\n---\n覆盖正文\n`, resolution: 'version', expectedRevision: 1 });
    expect(covered.status).toBe(200);
    expect(covered.body.data).toMatchObject({ id: imported.body.data.id, revision: 2, instructions: '覆盖正文', enabled: false });
    const renamed = await api.post('/api/skills/import').send({ markdown, resolution: 'rename', name: `${name}-另存` });
    expect(renamed.status).toBe(201);
    expect(renamed.body.data).toMatchObject({ name: `${name}-另存`, origin: 'import', instructions: '导入正文' });

    const missingConversation = await api.post('/api/skills/draft').send({ conversationId: 'missing-conversation' });
    expect(missingConversation.status).toBe(404);
    expect(missingConversation.body.code).toBe('NOT_FOUND');

    const conversation = await prisma.conversation.create({ data: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } });
    conversations.push(conversation.id);
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    await prisma.message.create({ data: { conversationId: conversation.id, role: 'user', content: '最旧标记', status: 'completed', createdAt: new Date(base).toISOString() } });
    for (let index = 1; index <= 30; index += 1) {
      await prisma.message.create({ data: { conversationId: conversation.id, role: index % 2 ? 'assistant' : 'user', content: index === 2 ? '长'.repeat(2001) : `消息${index}`, status: 'completed', createdAt: new Date(base + index * 1000).toISOString() } });
    }
    await prisma.message.create({ data: { conversationId: conversation.id, role: 'tool', content: '工具秘密', status: 'completed', createdAt: new Date(base + 40_000).toISOString() } });
    let seen = '';
    let tools: boolean | undefined;
    setSkillDraftModel({
      async complete(messages, _signal, includeTools) {
        tools = includeTools;
        seen = messages.map((message) => message.content).join('\n');
        return { text: '```json\n{"name":"起草技能","description":"从对话整理","instructions":"先做第一步"}\n```' };
      },
    });
    const before = await prisma.skill.count();
    const drafted = await api.post('/api/skills/draft').send({ conversationId: conversation.id });
    expect(drafted.status).toBe(200);
    expect(drafted.body).toEqual({ data: { name: '起草技能', description: '从对话整理', instructions: '先做第一步' }, error: null });
    expect(tools).toBe(false);
    expect(seen).not.toContain('最旧标记');
    expect(seen).not.toContain('工具秘密');
    expect(seen).toContain('消息1');
    expect(seen).toContain('消息30');
    expect(seen).toContain('长'.repeat(2000));
    expect(seen).not.toContain('长'.repeat(2001));
    expect(await prisma.skill.count()).toBe(before);

    setSkillDraftModel({ async complete() { return { text: '不是 JSON' }; } });
    const invalid = await api.post('/api/skills/draft').send({ conversationId: conversation.id });
    expect(invalid.status).toBe(502);
    expect(invalid.body).toMatchObject({ code: 'INVALID_MODEL_OUTPUT', error: '模型没有返回有效 JSON，技能未保存' });
    expect(await prisma.skill.count()).toBe(before);
  });

  it('requires an owner session', async () => {
    const response = await supertest(app).get('/api/skills');
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('AUTH_REQUIRED');
  });
});
