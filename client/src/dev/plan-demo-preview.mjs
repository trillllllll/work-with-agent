import { fork } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const client = join(root, 'client');
const entry = fileURLToPath(import.meta.url);
const port = Number(process.env.DOVUN_PLAN_PREVIEW_PORT ?? 39517);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid planning preview port.');
const origin = 'http://127.0.0.1:' + port;
const hash = (value) => createHash('sha256').update(value).digest('hex');

async function fixtureApi() {
  const token = process.env.DOVUN_PLAN_PREVIEW_SESSION;
  if (!token || !process.send) throw new Error('Start the planning preview without arguments.');
  const { migrateDatabase } = await import('../../../server/src/db-migrate.ts');
  await migrateDatabase();
  const { prisma } = await import('../../../server/src/infrastructure/prisma.ts');
  const stamp = new Date().toISOString();
  const current = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const day = (offset) => new Date(Date.parse(current + 'T00:00:00Z') + offset * 86_400_000).toISOString().slice(0, 10);
  const task = (id, title, offset, start, end, topicId) => {
    const date = offset === null ? null : day(offset);
    return { id, title, topicId, dueDate: date, scheduledStart: date && start ? date + 'T' + start : null,
      scheduledEnd: date && end ? date + 'T' + end : null, createdAt: stamp, updatedAt: stamp };
  };
  await prisma.localSession.create({ data: { id: 'planning-preview', tokenHash: hash(token), csrfHash: hash(hash('csrf:' + token)),
    createdAt: stamp, expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() } });
  await prisma.topic.createMany({ data: [
    { id: 'help', name: '帮助中心改版', color: 'blue' },
    { id: 'research', name: '用户访谈', color: 'violet' },
    { id: 'team', name: '团队协作', color: 'teal' },
  ] });
  await prisma.task.createMany({ data: [
    task('feedback', '梳理客服高频问题', -3, '09:00', '10:30', 'help'),
    task('kickoff', '改版范围内部讨论', -3, '14:00', '15:30', 'team'),
    task('notes', '整理访谈记录', -2, '10:30', '12:00', 'research'),
    task('checklist', '提交移动端回归清单', -1, null, null, 'help'),
    task('support', '与客服同步反馈', -1, '13:30', '15:00', 'help'),
    task('sync', '同步帮助文章负责人', 0, null, null, 'team'),
    { ...task('scope', '确认帮助中心首页的改版范围', 0, '10:00', '11:30', 'help'), status: 'doing', priority: 'high',
      description: '确认首页导航和首批帮助文章，检查手机上能否从首页两步找到退款和物流入口。' },
    task('research', '和支持团队回顾本月访谈记录', 0, '14:00', '15:30', 'research'),
    task('weekly', '整理周会讨论项', 0, '16:00', '17:00', 'team'),
    task('review', '第一轮改版走查', 1, '10:30', '12:00', 'help'),
    task('followup', '汇总走查反馈', 1, '15:00', '16:00', 'team'),
    task('queue-search', '统计退款问题的搜索频率', null, null, null, 'help'),
    task('queue-interview', '归档访谈笔记', null, null, null, 'research'),
    task('queue-titles', '整理现有帮助文章标题', null, null, null, 'help'),
  ] });
  await prisma.planTimeBand.createMany({ data: [
    { id: randomUUID(), name: '上午工作', startMinute: 9 * 60, endMinute: 12 * 60, weekdaysJson: '[1,2,3,4,5]', color: 'blue', position: 0 },
    { id: randomUUID(), name: '下午工作', startMinute: 13 * 60, endMinute: 18 * 60, weekdaysJson: '[1,2,3,4,5]', color: 'green', position: 1 },
  ] });
  const { app } = await import('../../../server/src/app.ts');
  const server = app.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
  process.on('disconnect', () => process.exit(0));
}

async function preview() {
  const data = await mkdtemp(join(tmpdir(), 'dovun-plan-preview-'));
  const token = randomBytes(32).toString('hex');
  const backend = fork(entry, ['--fixture-api'], {
    cwd: data,
    execArgv: ['--import', join(root, 'node_modules/tsx/dist/loader.mjs')],
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    env: {
      PATH: dirname(process.execPath) + delimiter + '/usr/bin' + delimiter + '/bin',
      CLIENT_ORIGIN: origin,
      DATABASE_URL: 'file:' + join(data, 'preview.db'),
      DOVUN_DATA_DIR: join(data, 'data'),
      DOVUN_RUNNER_DIR: join(data, 'runner'),
      DOVUN_COORDINATOR_DISABLED: '1',
      AGENT_WORKSPACE_ROOT: data,
      KNOWLEDGE_STORAGE_ROOT: join(data, 'blobs'),
      DOVUN_PLAN_PREVIEW_SESSION: token,
    },
  });
  const exited = new Promise((resolve) => backend.once('close', resolve));
  const cleanup = async () => {
    if (backend.exitCode === null && backend.signalCode === null) backend.kill();
    await exited;
    await rm(data, { recursive: true, force: true });
  };
  try {
    const apiPort = await new Promise((resolve, reject) => {
      backend.once('message', ({ port }) => resolve(port));
      backend.once('error', reject);
      backend.once('exit', (code) => reject(new Error('Preview fixture exited with code ' + code)));
    });
    const { createServer } = await import('vite');
    const vite = await createServer({
      root: client,
      configFile: join(client, 'vite.config.ts'),
      plugins: [{
        name: 'dovun-plan-demo',
        configureServer(server) {
          server.middlewares.use('/__dovun_plan_preview__', (_req, res) => {
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ fixture: 'dovun-plan' }));
          });
        },
      }],
      server: { host: '127.0.0.1', port, strictPort: true, proxy: {
        '/api': {
          target: 'http://127.0.0.1:' + apiPort,
          configure(proxy) {
            proxy.on('proxyReq', (req) => {
              req.setHeader('cookie', 'dovun_session=' + token);
              req.removeHeader('authorization');
            });
          },
        },
      } },
    });
    await vite.listen();
    console.log(origin + '/plan-demo.html#/plan');
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, async () => {
        if (stopping) return;
        stopping = true;
        await vite.close();
        await cleanup();
        process.exit(0);
      });
    }
  } catch (error) {
    await cleanup();
    throw error;
  }
}

if (process.argv[2] === '--fixture-api') await fixtureApi();
else await preview();
