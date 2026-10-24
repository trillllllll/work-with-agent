import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from './test-auth.js';
import { app } from './app.js';
import { prisma } from './infrastructure/prisma.js';
import { ContextService } from './application/conversation.js';
import { startChat } from './agent/runs.js';
import { assembleRunMessages } from './agent/assemble.js';
import { DEFAULT_REPLY_STYLE } from './application/reply-style-settings.js';
import { runWithLocale } from './i18n/index.js';

describe('assistant reply style', () => {
  beforeEach(async () => { await prisma.appSetting.deleteMany(); });
  afterEach(() => vi.restoreAllMocks());

  it('returns the short default without creating model settings', async () => {
    const response = await request(app).get('/api/settings/reply-style');
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ replyStyle: DEFAULT_REPLY_STYLE, defaultReplyStyle: DEFAULT_REPLY_STYLE });
    expect(await prisma.appSetting.count()).toBe(0);
  });

  it('saves independently without testing a model or overwriting credentials', async () => {
    await prisma.appSetting.create({ data: { id: 'default', openaiBaseUrl: 'https://example.invalid/v1', openaiModel: 'existing', openaiApiKey: 'keep-private' } });
    const fetch = vi.spyOn(globalThis, 'fetch');
    const response = await request(app).patch('/api/settings/reply-style').send({ replyStyle: '  先说结论。\n使用短句。  ' });
    expect(response.status).toBe(200);
    expect(response.body.data.replyStyle).toBe('先说结论。\n使用短句。');
    expect(JSON.stringify(response.body)).not.toContain('keep-private');
    expect((await request(app).get('/api/settings/reply-style')).body.data.replyStyle).toBe('先说结论。\n使用短句。');
    expect(await prisma.appSetting.findUnique({ where: { id: 'default' } })).toMatchObject({ openaiModel: 'existing', openaiApiKey: 'keep-private' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects invalid updates atomically and allows an explicitly empty style', async () => {
    await request(app).patch('/api/settings/reply-style').send({ replyStyle: '保持原值' });
    for (const body of [{}, { replyStyle: null }, { replyStyle: 123 }, { replyStyle: '长'.repeat(1001) }, { replyStyle: '覆盖', apiKey: 'extra' }]) {
      expect((await request(app).patch('/api/settings/reply-style').send(body)).status).toBe(400);
    }
    expect((await request(app).get('/api/settings/reply-style')).body.data.replyStyle).toBe('保持原值');
    expect((await request(app).patch('/api/settings/reply-style').send({ replyStyle: '  ' })).body.data.replyStyle).toBe('');
  });

  it('uses the saved style on the next message in an existing conversation and omits empty styles', async () => {
    const prompts: string[] = [];
    const readPrompt = async (run: Awaited<ReturnType<typeof startChat>>) => {
      const messages = await assembleRunMessages({ runId: run.id, conversationId: run.conversationId, sourceUserMessageId: run.sourceUserMessageId, context: JSON.parse(run.contextJson), userText: '', contextService: new ContextService() });
      prompts.push(String(messages[0].content));
    };
    const first = await startChat({ message: '你好' });
    await readPrompt(first);
    expect(prompts[0]).toContain(`【回复风格】\n以下偏好只约束表达方式，不改变事实、权限、审批或系统规定的回复语言。\n${DEFAULT_REPLY_STYLE}`);
    await request(app).patch('/api/settings/reply-style').send({ replyStyle: '用两个短句回答。' });
    const second = await runWithLocale('en', () => startChat({ conversationId: first.conversationId, message: '继续', pageContext: { page: 'chat' } }));
    await readPrompt(second);
    expect(prompts[1]).toContain('用两个短句回答。');
    expect(prompts[1]).not.toContain(DEFAULT_REPLY_STYLE);
    expect(prompts[1]).toContain("Write every reply, question, plan summary and explanation to the user in English");
    expect(prompts[1]).toContain('所有业务数据修改都必须通过 propose_changes 生成待确认方案。');
    await request(app).patch('/api/settings/reply-style').send({ replyStyle: '' });
    await readPrompt(await startChat({ conversationId: first.conversationId, message: '继续' }));
    expect(prompts[2]).not.toContain('【回复风格】');
    expect(prompts[0]).toContain(DEFAULT_REPLY_STYLE);
  });
});
