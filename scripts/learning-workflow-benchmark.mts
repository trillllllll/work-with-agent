import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { arch, cpus, loadavg, platform, release, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node --import tsx scripts/learning-workflow-benchmark.mts --db /tmp/learning-workflow-benchmark-NAME.db --out /absolute/report.json [--samples 30] [--compare /absolute/baseline.json] [--keep-db]');
  process.exit(0);
}
function option(name: string, required = false) {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (required && (!value || value.startsWith('--'))) throw new Error(`Missing ${name}`);
  return value;
}
const database = option('--db', true)!;
const output = option('--out', true)!;
const comparePath = option('--compare');
const samples = Number(option('--samples') ?? 30);
const keepDatabase = args.includes('--keep-db');
if (!Number.isInteger(samples) || samples < 10 || samples > 200) throw new Error('--samples must be 10–200');
if (!isAbsolute(database) || !isAbsolute(output)) throw new Error('--db and --out must be absolute paths');
if (!/^learning-workflow-benchmark-[\w.-]+\.db$/.test(basename(database))) throw new Error('Database filename must be learning-workflow-benchmark-NAME.db');
const realParent = realpathSync(dirname(database));
const temporaryRoots = [...new Set([realpathSync(tmpdir()), realpathSync('/tmp')])];
if (!temporaryRoots.some(root => realParent === root || realParent.startsWith(root + sep))) throw new Error('Database must be inside an existing temporary directory');
if ([database, `${database}-wal`, `${database}-shm`, `${database}-journal`, output].some(existsSync)) throw new Error('Refusing to overwrite an existing database, sidecar or report');
if (comparePath && !isAbsolute(comparePath)) throw new Error('--compare must be an absolute path');

type Phase = { name: string; nodes: number; attempts: number; events: number; activities: number };
const phases: Phase[] = [
  { name: 'small', nodes: 100, attempts: 20, events: 200, activities: 20 },
  { name: 'nodes-1000', nodes: 1000, attempts: 1000, events: 10000, activities: 1000 },
  { name: 'nodes-3000', nodes: 3000, attempts: 1000, events: 50000, activities: 3000 },
];
const anchor = '2026-10-01T00:00:00.000Z';
const mapId = 'benchmark-map';
const sessionId = 'benchmark-session';
const ownerId = 'local-owner';
let prior: Phase = { name: 'empty', nodes: 0, attempts: 0, events: 0, activities: 0 };

function migrate() {
  const db = new DatabaseSync(database);
  try {
    const folder = join(repository, 'server/prisma/migrations');
    for (const name of readdirSync(folder).sort()) {
      if (name === 'migration_lock.toml') continue;
      db.exec(readFileSync(join(folder, name, 'migration.sql'), 'utf8'));
    }
  } finally { db.close(); }
}

function seed(phase: Phase) {
  const started = performance.now();
  const db = new DatabaseSync(database);
  try {
    db.exec('PRAGMA foreign_keys = ON; BEGIN');
    if (prior.nodes === 0) {
      db.prepare('INSERT INTO learning_maps (id,title,goal,created_at,updated_at) VALUES (?,?,?,?,?)').run(mapId, '合成学习主题', '只用于可重放性能基线', anchor, anchor);
      db.prepare('INSERT INTO learning_practice_sessions (id,ownerId,mapId,mapTitle,generationJobId,mode,configJson,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(sessionId, ownerId, mapId, '合成学习主题', 'benchmark-generation', 'knowledge', JSON.stringify({ mapId, count: 20, types: ['single'], difficulty: 'medium' }), anchor, anchor);
    }
    const node = db.prepare('INSERT INTO learning_nodes (id,map_id,parent_id,kind,title,detail,status,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
    const review = db.prepare('INSERT INTO learning_review_items (id,ownerId,scopeKey,mapId,nodeId,title,reasonsJson,dueAt,paused,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)');
    const body = '基线正文：理解概念、应用条件、比较反例。'.repeat(40);
    for (let i = prior.nodes; i < phase.nodes; i++) {
      const group = i < 10;
      node.run(`node-${i}`, mapId, group ? null : `node-${i % 10}`, group ? 'topic' : 'item', `知识点 ${String(i).padStart(4, '0')}`, group ? '' : body, ['todo', 'learning', 'review', 'done'][i % 4], i, anchor, anchor);
      if (!group && i % 10 === 0) review.run(`review-${i}`, ownerId, `node:node-${i}`, mapId, `node-${i}`, `知识点 ${i}`, '["manual"]', null, i % 30 === 0 ? 1 : 0, anchor);
    }
    if (prior.nodes === 0) {
      const question = db.prepare('INSERT INTO learning_questions (id,mapId,nodeId,currentVersionId,createdAt) VALUES (?,?,?,?,?)');
      const version = db.prepare('INSERT INTO learning_question_versions (id,questionId,nodeId,nodeTitle,contentJson,promptVersion,createdAt) VALUES (?,?,?,?,?,?,?)');
      const item = db.prepare('INSERT INTO learning_practice_items (id,sessionId,questionVersionId,position,selectionReason) VALUES (?,?,?,?,?)');
      const draft = db.prepare('INSERT INTO learning_answer_drafts (id,itemId,activeAttemptId,answerJson,updatedAt) VALUES (?,?,?,?,?)');
      for (let i = 0; i < 20; i++) {
        const frozen = { nodeId: `node-${i + 10}`, type: 'single', prompt: `合成题 ${i}：请依据定义识别适用条件。`, options: [{ id: 'A', text: '条件完整，满足定义' }, { id: 'B', text: '缺少必要条件' }], answer: 'A', explanation: '完整解析：逐条核对定义和必要条件。'.repeat(8), rubric: '完全匹配得一分', hints: ['先回忆定义', '再核对条件'], difficulty: 'medium', objective: '识别适用条件', source: { kind: 'note', label: `知识点 ${i + 10}`, nodeRevision: 1 } };
        question.run(`question-${i}`, mapId, frozen.nodeId, `version-${i}`, anchor);
        version.run(`version-${i}`, `question-${i}`, frozen.nodeId, frozen.source.label, JSON.stringify(frozen), 'benchmark-v1', anchor);
        item.run(`item-${i}`, sessionId, `version-${i}`, i, 'selected_knowledge');
        draft.run(`draft-${i}`, `item-${i}`, `draft-attempt-${i}`, '""', anchor);
      }
      db.prepare('INSERT INTO learning_resume_state (ownerId,nodeId,mapId,nodeTitle,updatedAt) VALUES (?,?,?,?,?)').run(ownerId, 'node-10', mapId, '知识点 0010', anchor);
      db.prepare('INSERT INTO learning_activity (id,map_id,node_id,kind,content,meta_json,created_at) VALUES (?,?,?,?,?,?,?)').run('checkpoint', mapId, 'node-10', 'session', '合成的已确认学习记录', '{"schemaVersion":1,"type":"checkpoint"}', anchor);
    }
    const attempt = db.prepare('INSERT INTO learning_attempts (id,ownerId,itemId,questionVersionId,attemptNo,clientAttemptId,answerJson,submittedAt,gradingState,currentGradeId) VALUES (?,?,?,?,?,?,?,?,?,?)');
    const grade = db.prepare('INSERT INTO learning_grades (id,attemptId,version,method,state,result,score,maxScore,explanation,strengths,mistakesJson,promptVersion,createdAt) VALUES (?,?,1,?,?,?,?,?,?,?,?,?,?)');
    for (let i = prior.attempts; i < phase.attempts; i++) {
      const stamp = new Date(Date.parse(anchor) + (i + 1) * 1000).toISOString();
      attempt.run(`attempt-${i}`, ownerId, 'item-0', 'version-0', i + 1, `client-attempt-${i}`, '"A"', stamp, 'succeeded', `grade-${i}`);
      grade.run(`grade-${i}`, `attempt-${i}`, 'rule', 'succeeded', 'correct', 1, 1, '与冻结答案一致。'.repeat(20), '核心定义正确', '[]', 'benchmark-v1', stamp);
    }
    db.prepare('UPDATE learning_answer_drafts SET activeAttemptId=?,attemptNo=?,answerJson=?,submitted=1,revision=? WHERE itemId=?').run(`attempt-${phase.attempts - 1}`, phase.attempts, '"A"', phase.attempts + 1, 'item-0');
    const event = db.prepare('INSERT INTO learning_practice_events (id,ownerId,itemId,activeAttemptId,type,sourceMessageId,payloadJson,eventKey,createdAt) VALUES (?,?,?,?,?,?,?,?,?)');
    for (let i = prior.events; i < phase.events; i++) {
      const kind = ['hint', 'assistance_requested', 'assistance_delivered', 'skip', 'submission_snapshot'][i % 5];
      event.run(`event-${i}`, ownerId, 'item-0', `attempt-${i % phase.attempts}`, kind, `message-${Math.floor(i / 5)}`, kind === 'hint' ? '{"level":2}' : '{}', `event-key-${i}`, anchor);
    }
    const activity = db.prepare('INSERT INTO learning_activity (id,map_id,node_id,kind,content,meta_json,created_at) VALUES (?,?,?,?,?,?,?)');
    for (let i = prior.activities; i < phase.activities; i++) activity.run(`activity-${i}`, mapId, 'node-10', 'session', '普通合成学习动态', '{}', new Date(Date.parse(anchor) + (i + 1) * 1000).toISOString());
    db.exec('COMMIT; PRAGMA optimize');
  } catch (error) { try { db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw error; }
  finally { db.close(); }
  prior = phase;
  return performance.now() - started;
}

function percentile(values: number[], p: number) { const ordered = [...values].sort((a, b) => a - b); return ordered[Math.max(0, Math.ceil(p * ordered.length) - 1)]!; }
const round = (value: number) => Math.round(value * 1000) / 1000;
type Measurement = { operation: string; firstReadMs: number; medianMs: number; p95Ms: number; maxMs: number; responseBytes: { min: number; max: number }; pageLength: { min: number; max: number }; samplesMs: number[] };
type Stage = { phase: Phase; seedMs: number; databaseBytes: number; operations: Measurement[] };
const sourcePaths = ['server/src/application/learning-practice/read.ts', 'server/src/application/learning-practice/store.ts', 'server/src/application/learning-practice/assistance.ts', 'server/src/application/learning-practice/reviews.ts', 'server/prisma/schema.prisma', 'server/prisma/migrations/20261109000000_learning_practice/migration.sql'];
const sourceHashes = Object.fromEntries(sourcePaths.map(path => [path, createHash('sha256').update(readFileSync(join(repository, path))).digest('hex')]));
const baseline = comparePath ? JSON.parse(readFileSync(comparePath, 'utf8')) as { stages: Stage[] } : null;
const originalDirectory = process.cwd();
const isolation = await mkdtemp(join(tmpdir(), 'learning-workflow-benchmark-config-'));
let created = false;
let disconnect: (() => Promise<void>) | undefined;
try {
  closeSync(openSync(database, 'wx', 0o600)); created = true;
  // Prevent dotenv or desktop path helpers from looking in the checkout or real application directory.
  process.chdir(isolation);
  process.env.DATABASE_URL = `file:${database}`;
  process.env.DOVUN_DATA_DIR = isolation; process.env.WWA_DATA_DIR = isolation;
  process.env.DOVUN_MODE = 'local'; process.env.WWA_MODE = 'local';
  process.env.KNOWLEDGE_STORAGE_ROOT = join(isolation, 'knowledge');
  migrate();
  const { prisma } = await import('../server/src/infrastructure/prisma.ts');
  disconnect = () => prisma.$disconnect();
  const { searchLearning, practiceHistory, readPracticeSession, practiceOverview } = await import('../server/src/application/learning-practice/read.ts');
  const stages: Stage[] = [];
  for (const phase of phases) {
    await prisma.$disconnect();
    const seedMs = seed(phase);
    const operations: Measurement[] = [];
    const definitions = [
      { name: 'search-title', run: () => searchLearning({ mapId, q: '知识点', limit: 30 }), page: (r: any) => r.items.length, cap: 30 },
      { name: 'search-body', run: () => searchLearning({ mapId, q: '基线正文', limit: 30 }), page: (r: any) => r.items.length, cap: 30 },
      { name: 'history-first', run: () => practiceHistory({ mapId, limit: 30 }), page: (r: any) => r.items.length, cap: 30 },
      { name: 'history-deep', run: () => practiceHistory({ mapId, limit: 30, cursor: String(Math.max(0, phase.attempts - 100)) }), page: (r: any) => r.items.length, cap: 30 },
      { name: 'session', run: () => readPracticeSession(sessionId), page: (r: any) => r.items.length, cap: 20 },
      { name: 'overview', run: () => practiceOverview(), page: (r: any) => r.sessions.length, cap: 10 },
    ];
    for (const operation of definitions) {
      const measured = async () => {
        const start = performance.now(); const result = await operation.run();
        const serialized = JSON.stringify({ data: result, error: null });
        const duration = performance.now() - start; const length = operation.page(result);
        if (length < 1 || length > operation.cap) throw new Error(`${phase.name}/${operation.name}: unexpected page length ${length}`);
        if (operation.name === 'session') for (const item of (result as any).items) {
          if (item.attempts.length > 5 || item.attempts.some((a: any) => a.grades.length > 5)) throw new Error('Unbounded session history payload');
        }
        if (operation.name === 'overview' && (result as any).checkpoint?.id !== 'checkpoint') throw new Error('Checkpoint hidden by ordinary activity');
        return { duration, bytes: Buffer.byteLength(serialized), length };
      };
      const firstRead = await measured();
      for (let i = 0; i < 3; i++) await measured();
      const runs = []; for (let i = 0; i < samples; i++) runs.push(await measured());
      const durations = runs.map(r => r.duration);
      operations.push({ operation: operation.name, firstReadMs: round(firstRead.duration), medianMs: round(percentile(durations, .5)), p95Ms: round(percentile(durations, .95)), maxMs: round(Math.max(...durations)), responseBytes: { min: Math.min(...runs.map(r => r.bytes)), max: Math.max(...runs.map(r => r.bytes)) }, pageLength: { min: Math.min(...runs.map(r => r.length)), max: Math.max(...runs.map(r => r.length)) }, samplesMs: durations.map(round) });
    }
    stages.push({ phase, seedMs: round(seedMs), databaseBytes: statSync(database).size, operations });
    console.log(JSON.stringify({ phase: phase.name, measured: operations.map(o => ({ operation: o.operation, p95Ms: o.p95Ms, bytes: o.responseBytes.max, page: o.pageLength.max })) }));
  }
  const comparisons = baseline ? stages.flatMap(stage => stage.operations.map(measured => {
    const previous = baseline.stages.find(s => s.phase.name === stage.phase.name)?.operations.find(o => o.operation === measured.operation);
    if (!previous) throw new Error('Baseline is missing a measured phase/operation');
    const budgetMs = Math.ceil(Math.max(previous.p95Ms * 2, previous.maxMs * 1.25));
    const bytesBudget = Math.ceil(previous.responseBytes.max * 1.05);
    return { phase: stage.phase.name, operation: measured.operation, budgetMs, p95Ms: measured.p95Ms, bytesBudget, responseBytes: measured.responseBytes.max, passed: measured.p95Ms <= budgetMs && measured.responseBytes.max <= bytesBudget && measured.pageLength.max <= previous.pageLength.max };
  })) : [];
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), syntheticOnly: true, database, databaseRetained: keepDatabase, node: process.version, os: `${platform()} ${release()} ${arch()}`, cpu: cpus()[0]?.model, cpuCount: cpus().length, loadAverageAtEnd: loadavg(), gitRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(), workingTreeDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: repository, encoding: 'utf8' }).trim()), sourceHashes, methodology: { samples, warmups: 3, includes: ['application read service', 'JSON envelope serialization'], excludes: ['HTTP/network', 'browser rendering', 'model latency', 'concurrent requests'], notes: ['First read is after synthetic seeding; it is not a cold disk test.', 'Nodes include 10 groups. One 20-item session concentrates attempt/event history on item-0.', 'Each stage extends the same isolated database; no real settings or data are loaded.'] }, stages, comparisons, ok: comparisons.every(result => result.passed) };
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(`Report: ${output}`);
  if (!report.ok) process.exitCode = 1;
} finally {
  await disconnect?.(); process.chdir(originalDirectory);
  if (created && !keepDatabase) for (const path of [database, `${database}-wal`, `${database}-shm`, `${database}-journal`]) await rm(path, { force: true });
  await rm(isolation, { recursive: true, force: true });
}
