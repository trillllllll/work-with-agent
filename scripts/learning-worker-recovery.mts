import { DatabaseSync } from 'node:sqlite';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const repository = fileURLToPath(new URL('../', import.meta.url));
const script = fileURLToPath(import.meta.url);
const arguments_ = process.argv.slice(2);
const option = (name: string) => { const i = arguments_.indexOf(name); return i < 0 ? undefined : arguments_[i + 1]; };
if (arguments_.includes('--help')) {
  console.log('Usage: node --import tsx scripts/learning-worker-recovery.mts --db /tmp/learning-worker-recovery-NAME.db --out /absolute/report.json [--keep-db]');
  process.exit(0);
}
const database = option('--db');
const output = option('--out');
const childMode = option('--child');
const runId = option('--run-id') ?? randomUUID();
if (!database || !isAbsolute(database) || !/^learning-worker-recovery-[\w.-]+\.db$/.test(basename(database))) throw new Error('Provide an absolute temporary --db named learning-worker-recovery-NAME.db');
const parent = realpathSync(dirname(database));
if (![realpathSync(tmpdir()), realpathSync('/tmp')].some(root => parent === root || parent.startsWith(root + sep))) throw new Error('Database must be in a temporary directory');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const answer = '合成原始答案：我认为条件 A 足够，不需要条件 B。';
const answerJson = JSON.stringify(answer);
const question = { nodeId: 'recovery-node', type: 'short', prompt: '合成简答题：定义需要满足哪些条件？', options: [], answer: '同时满足 A 和 B', explanation: '这是恢复测试使用的合成解析。', rubric: '两个必要条件都需要说明', hints: ['检查必要条件'], difficulty: 'medium', objective: '识别必要条件', source: { kind: 'model_example', label: '恢复测试合成题' } };

function snapshot() {
  const db = new DatabaseSync(database!, { readOnly: true });
  try {
    const job = db.prepare('SELECT state,retries,leaseToken,leaseExpiresAt,gradingVersion FROM learning_jobs WHERE id=?').get('recovery-job') as Record<string, unknown>;
    const attempt = db.prepare('SELECT answerJson,gradingState,currentGradeId,gradingVersion FROM learning_attempts WHERE id=?').get('recovery-attempt') as Record<string, unknown>;
    return { job, attempt, answerHash: hash(String(attempt.answerJson)), grades: Number(db.prepare('SELECT COUNT(*) AS count FROM learning_grades').get()!.count), reviews: Number(db.prepare('SELECT COUNT(*) AS count FROM learning_review_items').get()!.count), reviewEvents: Number(db.prepare('SELECT COUNT(*) AS count FROM learning_review_events').get()!.count) };
  } finally { db.close(); }
}

if (childMode) {
  if (!['claim-and-block', 'recover'].includes(childMode) || !existsSync(database)) throw new Error('Invalid child invocation');
  const marker = JSON.parse(readFileSync(join(process.cwd(), 'recovery-marker.json'), 'utf8')) as { runId: string; database: string };
  if (marker.runId !== runId || marker.database !== database) throw new Error('Child marker does not match this synthetic database');
  const fixture = new DatabaseSync(database, { readOnly: true });
  try { if (fixture.prepare('SELECT runId FROM learning_recovery_fixture').get()?.runId !== runId) throw new Error('Not a recovery fixture'); }
  finally { fixture.close(); }
  // The parent supplies only a small environment allowlist and an empty isolated cwd.
  process.env.DATABASE_URL = `file:${database}`;
  process.env.DOVUN_DATA_DIR = process.cwd(); process.env.WWA_DATA_DIR = process.cwd();
  const { prisma } = await import('../server/src/infrastructure/prisma.ts');
  const { setPracticeModel, runPracticeJobs } = await import('../server/src/application/learning-practice/worker.ts');
  let hold: ReturnType<typeof setInterval> | undefined;
  try {
    setPracticeModel({ complete: async messages => {
      const input = JSON.parse(String(messages.at(-1)?.content));
      if (!String(messages[0]?.content).includes('DOVUN_PRACTICE_GRADE_V1') || input.answer !== answer) throw new Error('Unexpected model fixture request');
      if (childMode === 'claim-and-block') {
        console.log(JSON.stringify({ event: 'model-entered', pid: process.pid, at: new Date().toISOString() }));
        hold = setInterval(() => {}, 1000);
        return await new Promise<never>(() => {});
      }
      return { text: JSON.stringify({ result: 'incorrect', score: 0, maxScore: 1, explanation: '模拟判题：缺少条件 B。', strengths: '识别了条件 A', mistakes: ['缺少必要条件 B'], needsReview: false }), model: 'controlled-recovery-fixture' };
    } });
    const processed = await runPracticeJobs(3);
    console.log(JSON.stringify({ event: 'worker-finished', pid: process.pid, processed, at: new Date().toISOString() }));
  } finally { if (hold) clearInterval(hold); setPracticeModel(null); await prisma.$disconnect(); }
  process.exit(0);
}

if (!output || !isAbsolute(output)) throw new Error('Provide an absolute --out');
if ([database, `${database}-wal`, `${database}-shm`, `${database}-journal`, output].some(existsSync)) throw new Error('Refusing to overwrite an existing database, sidecar or report');
const isolation = await mkdtemp(join(tmpdir(), 'learning-worker-recovery-config-'));
writeFileSync(join(isolation, 'recovery-marker.json'), JSON.stringify({ runId, database }), { mode: 0o600 });
const children: ChildProcess[] = [];
let created = false;
const started = performance.now();
const startedAt = new Date().toISOString();
function launch(mode: string) {
  const child = spawn(process.execPath, ['--import', fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url)), script, '--child', mode, '--db', database!, '--run-id', runId], {
    cwd: isolation, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: isolation, TMPDIR: isolation, NODE_ENV: 'test', DATABASE_URL: `file:${database}`, DOVUN_DATA_DIR: isolation, WWA_DATA_DIR: isolation, DOVUN_MODE: 'local', WWA_MODE: 'local' },
  });
  children.push(child);
  const events: Array<Record<string, unknown>> = []; let buffered = ''; let stderr = '';
  child.stdout!.on('data', chunk => {
    buffered += String(chunk);
    let newline: number;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
      try { events.push(JSON.parse(line)); } catch { /* non-protocol output is not a readiness signal */ }
    }
  });
  child.stderr!.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-3000); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  async function waitFor(event: string, timeout = 30000) {
    const limit = Date.now() + timeout;
    while (Date.now() < limit) {
      const found = events.find(value => value.event === event); if (found) return found;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Child exited before ${event}: ${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`Child did not emit ${event} within ${timeout} ms`);
  }
  return { child, events, exited, waitFor };
}

try {
  closeSync(openSync(database, 'wx', 0o600)); created = true;
  const db = new DatabaseSync(database);
  try {
    const migrations = join(repository, 'server/prisma/migrations');
    for (const name of readdirSync(migrations).sort()) if (name !== 'migration_lock.toml') db.exec(readFileSync(join(migrations, name, 'migration.sql'), 'utf8'));
    db.exec('CREATE TABLE learning_recovery_fixture (runId TEXT NOT NULL)');
    db.prepare('INSERT INTO learning_recovery_fixture VALUES (?)').run(runId);
    const stamp = new Date().toISOString();
    db.exec('BEGIN');
    db.prepare('INSERT INTO learning_maps (id,title,created_at,updated_at) VALUES (?,?,?,?)').run('recovery-map', '恢复合成主题', stamp, stamp);
    db.prepare('INSERT INTO learning_nodes (id,map_id,kind,title,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('recovery-node', 'recovery-map', 'item', '恢复合成知识点', stamp, stamp);
    db.prepare('INSERT INTO learning_questions (id,mapId,nodeId,currentVersionId,createdAt) VALUES (?,?,?,?,?)').run('recovery-question', 'recovery-map', 'recovery-node', 'recovery-version', stamp);
    db.prepare('INSERT INTO learning_question_versions (id,questionId,nodeId,nodeTitle,contentJson,promptVersion,createdAt) VALUES (?,?,?,?,?,?,?)').run('recovery-version', 'recovery-question', 'recovery-node', '恢复合成知识点', JSON.stringify(question), 'recovery-v1', stamp);
    db.prepare('INSERT INTO learning_practice_sessions (id,ownerId,mapId,mapTitle,generationJobId,mode,configJson,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)').run('recovery-session', 'local-owner', 'recovery-map', '恢复合成主题', 'recovery-generation', 'knowledge', '{}', stamp, stamp);
    db.prepare('INSERT INTO learning_practice_items (id,sessionId,questionVersionId,position,selectionReason) VALUES (?,?,?,?,?)').run('recovery-item', 'recovery-session', 'recovery-version', 0, 'selected_knowledge');
    db.prepare('INSERT INTO learning_answer_drafts (id,itemId,activeAttemptId,answerJson,submitted,updatedAt) VALUES (?,?,?,?,1,?)').run('recovery-draft', 'recovery-item', 'recovery-attempt', answerJson, stamp);
    db.prepare('INSERT INTO learning_attempts (id,ownerId,itemId,questionVersionId,attemptNo,clientAttemptId,answerJson,submittedAt) VALUES (?,?,?,?,1,?,?,?)').run('recovery-attempt', 'local-owner', 'recovery-item', 'recovery-version', 'recovery-client-attempt', answerJson, stamp);
    db.prepare('INSERT INTO learning_jobs (id,ownerId,kind,mapId,sessionId,attemptId,gradingVersion,inputJson,createdAt,updatedAt) VALUES (?,?,?,?,?,?,1,?,?,?)').run('recovery-job', 'local-owner', 'grade', 'recovery-map', 'recovery-session', 'recovery-attempt', JSON.stringify({ question, answer, assistance: { assisted: false, solutionViewed: false, uncertain: false }, reason: '' }), stamp, stamp);
    db.exec('COMMIT');
  } finally { db.close(); }
  const before = snapshot();
  const first = launch('claim-and-block'); const entered = await first.waitFor('model-entered');
  const claimed = snapshot();
  if (claimed.job.state !== 'running' || !claimed.job.leaseToken || !claimed.job.leaseExpiresAt || claimed.grades !== 0) throw new Error('Worker did not durably claim the pending job');
  const expiry = Date.parse(String(claimed.job.leaseExpiresAt));
  const remainingAtKill = expiry - Date.now();
  if (remainingAtKill < 110000 || remainingAtKill > 120000) throw new Error('Expected the real approximately 120 second production lease');
  if (!first.child.kill('SIGKILL')) throw new Error('Could not stop the exact child created by this script');
  const killed = await first.exited; const killedAt = new Date().toISOString();
  if (killed.signal !== 'SIGKILL') throw new Error('Expected an actual SIGKILL process exit');
  const afterKill = snapshot();
  if (afterKill.answerHash !== before.answerHash || afterKill.job.state !== 'running' || afterKill.grades !== 0) throw new Error('Answer or pending job changed after process termination');
  console.log(JSON.stringify({ event: 'child-killed', pid: first.child.pid, killedAt, leaseExpiresAt: claimed.job.leaseExpiresAt, remainingMs: remainingAtKill }));
  const waitStart = performance.now();
  while (Date.now() <= expiry + 100) {
    const remaining = expiry + 101 - Date.now();
    console.log(JSON.stringify({ event: 'waiting-for-real-lease', remainingMs: remaining }));
    await new Promise(resolve => setTimeout(resolve, Math.min(remaining, 20000)));
  }
  const waitedMs = performance.now() - waitStart;
  const second = launch('recover'); const recoveredEvent = await second.waitFor('worker-finished'); const recoveredExit = await second.exited;
  const recovered = snapshot();
  if (recoveredExit.code !== 0 || recoveredEvent.processed !== 1 || recovered.job.state !== 'succeeded' || recovered.job.retries !== 2 || recovered.answerHash !== before.answerHash || recovered.grades !== 1 || recovered.reviews !== 1 || recovered.reviewEvents !== 1) throw new Error('Restart did not recover exactly one grade/review from the original answer');
  const third = launch('recover'); const repeatedEvent = await third.waitFor('worker-finished'); const repeatedExit = await third.exited;
  const repeated = snapshot();
  if (repeatedExit.code !== 0 || repeatedEvent.processed !== 0 || JSON.stringify(recovered) !== JSON.stringify(repeated)) throw new Error('Repeat execution duplicated or altered recovered state');
  const report = { schemaVersion: 1, ok: true, syntheticOnly: true, realProcessTermination: true, leaseEdited: false, model: 'injected controlled fixture only', runId, startedAt, completedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started), waitedMs: Math.round(waitedMs), database, databaseRetained: arguments_.includes('--keep-db'), sourceHashes: Object.fromEntries(['server/src/application/learning-practice/worker.ts', 'server/src/application/learning-practice/reviews.ts', 'scripts/learning-worker-recovery.mts'].map(path => [path, hash(readFileSync(join(repository, path), 'utf8'))])), children: { killedPid: first.child.pid, recoveredPid: second.child.pid, repeatedPid: third.child.pid, entered, killed, recoveredEvent, repeatedEvent }, before, claimed, afterKill, recovered, repeated };
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ event: 'completed', output, elapsedMs: report.elapsedMs, waitedMs: report.waitedMs, ok: true }));
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  if (created && !arguments_.includes('--keep-db')) for (const path of [database, `${database}-wal`, `${database}-shm`, `${database}-journal`]) await rm(path, { force: true });
  await rm(isolation, { recursive: true, force: true });
}
