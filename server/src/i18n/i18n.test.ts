import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../app.js';
import { localeFromAcceptLanguage, localeFromRequest, runWithLocale, currentLocale, translateMessage, translatePayload } from './index.js';
import { en } from './locales/en.js';
import { assembleRunMessages, replyLanguageInstruction } from '../agent/assemble.js';
import { startChat } from '../agent/runs.js';
import { ContextService } from '../application/conversation.js';

describe('server i18n', () => {
  it('prefers X-WWA-Language, then Accept-Language, then zh-CN', () => {
    expect(localeFromRequest({ headers: { 'x-dovun-language': 'en', 'accept-language': 'zh-CN' } })).toBe('en');
    expect(localeFromRequest({ headers: { 'x-dovun-language': 'zh-CN', 'accept-language': 'en-US' } })).toBe('zh-CN');
    expect(localeFromRequest({ headers: { 'accept-language': 'fr-FR,en-GB;q=0.8,zh;q=0.5' } })).toBe('en');
    expect(localeFromRequest({ headers: { 'accept-language': 'fr-FR' } })).toBe('zh-CN');
    expect(localeFromRequest({ headers: {} })).toBe('zh-CN');
    expect(localeFromAcceptLanguage('zh-TW;q=0.9, en;q=0.4')).toBe('zh-CN');
  });

  it('translates exact messages, templates and joined messages only for English', () => {
    expect(translateMessage('请先登录本机工作区', 'en')).toBe(en['请先登录本机工作区']);
    expect(translateMessage('请先登录本机工作区', 'zh-CN')).toBe('请先登录本机工作区');
    const template = Object.keys(en).find((key) => key.includes('{0}') && !key.startsWith('{0}'))!;
    const sample = template.replace(/\{(\d+)\}/g, (_, n) => `X${n}`);
    expect(translateMessage(sample, 'en')).toBe(en[template].replace(/\{(\d+)\}/g, (_, n) => `X${n}`));
    expect(translateMessage('请先登录本机工作区；连接已撤销', 'en')).toBe(`${en['请先登录本机工作区']}; ${en['连接已撤销']}`);
    expect(translateMessage('用户自己写的内容', 'en')).toBe('用户自己写的内容');
  });

  it('only translates message-like fields of a payload', () => {
    const payload = { data: { title: '连接已撤销', message: '连接已撤销' }, error: '请先登录本机工作区' };
    expect(translatePayload(payload, 'en')).toEqual({ data: { title: '连接已撤销', message: en['连接已撤销'] }, error: en['请先登录本机工作区'] });
    expect(translatePayload(payload, 'zh-CN')).toBe(payload);
  });

  it('keeps the request locale across awaits', async () => {
    await runWithLocale('en', async () => { await new Promise((resolve) => setTimeout(resolve, 1)); expect(currentLocale()).toBe('en'); });
    expect(currentLocale()).toBe('zh-CN');
  });

  it('answers API errors in the requested language', async () => {
    const zh = await supertest(app).get('/api/tasks/missing');
    expect(zh.status).toBe(401);
    expect(zh.body.error).toBe('请先登录本机工作区');
    const english = await supertest(app).get('/api/tasks/missing').set('X-Dovun-Language', 'en');
    expect(english.status).toBe(401);
    expect(english.body).toMatchObject({ error: en['请先登录本机工作区'], code: 'AUTH_REQUIRED' });
    const browser = await supertest(app).get('/api/tasks/missing').set('Accept-Language', 'en-US,en;q=0.9');
    expect(browser.body.error).toBe(en['请先登录本机工作区']);
  });

  it('tells the assistant to reply in the UI language without rewriting the prompt', async () => {
    const english = await runWithLocale('en', () => startChat({ message: 'Plan my week', pageContext: { page: 'inbox' }, requestKey: `i18n-en-${Date.now()}` }));
    const chinese = await startChat({ message: '安排这周', pageContext: { page: 'inbox' }, requestKey: `i18n-zh-${Date.now()}` });
    expect(JSON.parse(english.contextJson).language).toBe('en');
    expect(JSON.parse(chinese.contextJson).language).toBeUndefined();
    const system = async (run: typeof english) => (await assembleRunMessages({ runId: run.id, conversationId: run.conversationId, sourceUserMessageId: run.sourceUserMessageId, context: JSON.parse(run.contextJson), userText: '', contextService: new ContextService() }))[0].content as string;
    const [en, zh] = await Promise.all([system(english), system(chinese)]);
    expect(en).toContain(replyLanguageInstruction);
    expect(zh).not.toContain(replyLanguageInstruction);
    // The Chinese prompt itself is unchanged; only the instruction is added.
    expect(en.startsWith(zh.slice(0, 200))).toBe(true);
  });
});
