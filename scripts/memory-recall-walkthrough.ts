// P5 开发服务走查脚本（docs/2026-11-04_memory-recall-plan.md 第 7 节 P5）。
// 在开发服务的临时数据目录上验证：常驻记忆、简单回复跳过、相关记忆命中、预估与实际一致。
// 只读组装函数，不调用模型。用法：DATABASE_URL=file:<dev 库> tsx scripts/memory-recall-walkthrough.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'wwa-p5-walkthrough-'));
process.env.DOVUN_DATA_DIR = process.env.DOVUN_DATA_DIR ?? scratch;

async function main() {
if (!process.env.DATABASE_URL) throw new Error('需要 DATABASE_URL 指向开发服务的库');
const { migrateDatabase } = await import('../server/src/db-migrate.js');
await migrateDatabase(process.env.DATABASE_URL);

const prisma = (await import('../server/src/infrastructure/prisma.js')).prisma;
const { assemblePreviewMessages, assembleRunMessages } = await import('../server/src/agent/assemble.js');
const { ContextService } = await import('../server/src/application/conversation.js');
const { contextFromRequest } = await import('../server/src/agent/chat-context.js');

const stamp = new Date().toISOString();
const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};
const sectionOf = (prompt: string, header: string) => {
  const start = prompt.indexOf(`【${header}】`);
  if (start < 0) return null;
  const next = prompt.indexOf('【', start + 1);
  return prompt.slice(start, next < 0 ? undefined : next).trim();
};

// 场景数据：清单 A 有约束、五星和普通事实；清单 B 只有普通记忆。
const topicA = 'walk-topic-a';
const topicB = 'walk-topic-b';
await prisma.topic.create({ data: { id: topicA, name: '走查清单甲', createdAt: stamp, updatedAt: stamp } });
await prisma.topic.create({ data: { id: topicB, name: '走查清单乙', createdAt: stamp, updatedAt: stamp } });
const rows = [
  { id: 'walk-constraint', topicId: topicA, kind: 'constraint', importance: 3, title: '走查约束：发布必须走灰度', content: '所有发布先灰度百分之五再全量，不允许跳过。' },
  { id: 'walk-five', topicId: topicA, kind: 'fact', importance: 5, title: '走查五星事实', content: '域名注册商只留一家，续费按五年买。' },
  { id: 'walk-plain', topicId: topicA, kind: 'fact', importance: 2, title: '微波炉除味做法', content: '微波炉除味用柠檬水加热三分钟，然后擦干内壁。' },
  { id: 'walk-b-plain', topicId: topicB, kind: 'fact', importance: 2, title: '乙清单普通记忆', content: '乙清单的常规约定内容。' },
];
for (const row of rows) {
  await prisma.memory.create({ data: { ...row, identityId: 'work', status: 'active', revision: 1, labels: '[]', evidence: '[]', createdAt: stamp, updatedAt: stamp } });
}

const contextA = { ...contextFromRequest({ pageContext: { page: 'board', topicId: topicA } }), identityId: 'work' } as never;

// 1) 有常驻记忆：约束与五星进常驻，普通事实按问题召回。
const question = '微波炉里的味道怎么去掉';
const previewHit = await assemblePreviewMessages({ conversationId: null, context: contextA, identityId: 'work', userText: question });
const systemHit = String(previewHit[0]?.content ?? '');
const coreA = sectionOf(systemHit, '常驻记忆');
const recallA = sectionOf(systemHit, '相关记忆');
check('常驻记忆包含约束条目', coreA?.includes('walk-constraint') ?? false);
check('常驻记忆包含五星条目', coreA?.includes('walk-five') ?? false);
check('相关记忆按问题召回普通事实', recallA?.includes('walk-plain') ?? false, recallA?.slice(0, 120) ?? '');
check('相关记忆不重复常驻条目', !(recallA ?? '').includes('walk-constraint') && !(recallA ?? '').includes('walk-five'));

// 2) 简单回复：相关记忆为空，常驻保留。
const previewTrivial = await assemblePreviewMessages({ conversationId: null, context: contextA, identityId: 'work', userText: '好的。' });
const systemTrivial = String(previewTrivial[0]?.content ?? '');
const recallTrivial = sectionOf(systemTrivial, '相关记忆');
check('简单回复跳过检索', (recallTrivial ?? '').includes('无。'), recallTrivial ?? '');
check('简单回复仍带常驻记忆', (sectionOf(systemTrivial, '常驻记忆') ?? '').includes('walk-constraint'));

// 3) 无常驻记忆的清单：占位文案。
const contextB = { ...contextFromRequest({ pageContext: { page: 'board', topicId: topicB } }), identityId: 'work' } as never;
const previewB = await assemblePreviewMessages({ conversationId: null, context: contextB, identityId: 'work', userText: '乙清单的常规约定是什么' });
const coreB = sectionOf(String(previewB[0]?.content ?? ''), '常驻记忆');
check('无常驻记忆时显示占位', (coreB ?? '').includes('（没有常驻记忆）'), coreB ?? '');

// 4) 预估接口与实际请求的记忆块一致（不变量 6）。
const conversation = await prisma.conversation.create({ data: { identityId: 'work', createdAt: stamp, updatedAt: stamp } });
const userMessage = await prisma.message.create({ data: { conversationId: conversation.id, role: 'user', content: question, status: 'completed', createdAt: stamp } });
const actual = await assembleRunMessages({
  runId: 'walkthrough-run', conversationId: conversation.id, sourceUserMessageId: userMessage.id,
  context: contextA, identityId: 'work', userText: question, contextService: new ContextService(), skills: [],
});
const systemActual = String(actual[0]?.content ?? '');
check('预估与实际的常驻记忆一致', sectionOf(systemHit, '常驻记忆') === sectionOf(systemActual, '常驻记忆'));
check('预估与实际的相关记忆一致', sectionOf(systemHit, '相关记忆') === sectionOf(systemActual, '相关记忆'));

await prisma.$disconnect();
console.log(failures.length ? `\n走查失败：${failures.join('；')}` : '\n走查全部通过');
process.exitCode = failures.length ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
