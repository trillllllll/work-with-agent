// 本机 Dovun 覆盖安装前的备份。Dovun 必须已退出、47317 无监听。
// 备份放到 <根目录>/<YYYYMMDD-HHMMSS>-<提交短哈希>/，命名与 prune-local-backups.mjs 一致：
//   data/                     数据目录（排除其中的 backups/）
//   WebKit-app.dovun.desktop/ 等浏览器状态与偏好
//   Dovun-before.zip          旧应用（--no-app 跳过）
//   manifest.json             来源路径、大小、sha256、旧应用身份
// 复制先写到 .incomplete-<名称>/，全部核对通过后才改成正式名称。
//
// 用法：
//   node scripts/backup-local-install.mjs                    # 备份，提交哈希取当前仓库 HEAD
//   node scripts/backup-local-install.mjs --commit <哈希>     # 指定这次要安装的提交
//   node scripts/backup-local-install.mjs --no-app           # 不打包旧应用
//   node scripts/backup-local-install.mjs --verify <备份目录>  # 安装后核对数据库与偏好未变
//   --root <目录> 改备份根目录；--data-dir <目录> 或 DOVUN_DATA_DIR 改数据目录
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, readFileSync, readdirSync, renameSync, statfsSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const home = homedir();
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const fail = (message) => { console.error(`备份中止：${message}`); process.exit(1); };

const appPath = '/Applications/Dovun.app';
const appId = 'app.dovun.desktop';
const port = 47317;
const root = resolve(option('--root') ?? join(home, 'WorkSpace/.backups/dovun-local'));
const dataDir = resolve(option('--data-dir') ?? process.env.DOVUN_DATA_DIR ?? join(home, 'Library/Application Support/dovun'));
const dbFiles = ['dovun.db', 'dovun.db-wal', 'dovun.db-shm', 'dovun.db-journal'];
// 浏览器状态与偏好：name 是备份里的名称，verify 表示安装前后必须一致（缓存不核对）。
const browserState = [
  { name: 'WebKit-app.dovun.desktop', path: join(home, 'Library/WebKit', appId), verify: true },
  { name: 'app-support-app.dovun.desktop', path: join(home, 'Library/Application Support', appId), verify: true },
  { name: 'app.dovun.desktop.plist', path: join(home, 'Library/Preferences', `${appId}.plist`), verify: true },
  { name: 'Caches-app.dovun.desktop', path: join(home, 'Library/Caches', appId), verify: false },
];

const sha256 = (path) => new Promise((done, reject) => {
  const hash = createHash('sha256');
  createReadStream(path).on('error', reject).on('data', (chunk) => hash.update(chunk)).on('end', () => done(hash.digest('hex')));
});

// 遍历目录，不跟随符号链接。返回按相对路径排序的条目。
function walk(base, skipTop = new Set()) {
  const out = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const rel = relative(base, path);
      if (dir === base && skipTop.has(entry.name)) continue;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) out.push({ rel, type: 'link', size: 0 });
      else if (stat.isDirectory()) { out.push({ rel, type: 'dir', size: 0 }); visit(path); }
      else if (stat.isFile()) out.push({ rel, type: 'file', size: stat.size });
      else out.push({ rel, type: 'other', size: 0 });
    }
  };
  visit(base);
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

const summarize = (entries) => ({
  files: entries.filter((e) => e.type === 'file').length,
  links: entries.filter((e) => e.type === 'link').length,
  dirs: entries.filter((e) => e.type === 'dir').length,
  bytes: entries.reduce((sum, e) => sum + e.size, 0),
});

// 文件取 sha256；目录取「相对路径、类型、大小、文件 sha256」逐行拼接后的 sha256。
async function digest(path) {
  const stat = lstatSync(path);
  if (stat.isFile()) return { size: stat.size, sha256: await sha256(path) };
  const hash = createHash('sha256');
  const entries = walk(path);
  for (const e of entries) hash.update(`${e.rel}\t${e.type}\t${e.size}\t${e.type === 'file' ? await sha256(join(path, e.rel)) : ''}\n`);
  return { ...summarize(entries), sha256: hash.digest('hex') };
}

const human = (bytes) => bytes >= 2 ** 30 ? `${(bytes / 2 ** 30).toFixed(1)}G` : `${Math.round(bytes / 2 ** 20)}M`;

// ---------- 安装后核对 ----------
if (args.includes('--verify')) {
  const dir = resolve(option('--verify') ?? fail('--verify 需要备份目录'));
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) fail(`找不到 ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  let changed = 0;
  for (const item of manifest.checks) {
    const now = existsSync(item.source) ? await digest(item.source) : null;
    const same = now ? now.sha256 === item.sha256 : item.sha256 === null;
    if (!same) changed += 1;
    console.log(`  ${same ? '一致' : '不同'}  ${item.source}${same ? '' : `（备份时 ${item.sha256 ?? '不存在'}，现在 ${now?.sha256 ?? '不存在'}）`}`);
  }
  console.log(changed ? `${changed} 项与备份时不同` : '数据库与偏好均与备份时一致');
  process.exit(changed ? 1 : 0);
}

// ---------- 备份前检查 ----------
const inside = (child, parent) => child === parent || child.startsWith(parent + sep);
if (root === home || root === '/') fail('备份根目录不能是家目录或根目录');
for (const guarded of [dataDir, '/Applications', ...browserState.map((s) => s.path)]) {
  if (inside(root, guarded) || inside(guarded, root)) fail(`备份根目录与受保护位置重叠：${guarded}`);
}
if (existsSync(root) && lstatSync(root).isSymbolicLink()) fail(`备份根目录不能是符号链接：${root}`);
if (!existsSync(join(dataDir, 'dovun.db'))) fail(`数据目录里没有 dovun.db：${dataDir}`);

const running = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  .split('\n').map((line) => line.trim()).filter((line) => line.includes(`${appPath}/`));
if (running.length) fail(`Dovun 仍在运行，先正常退出：\n  ${running.join('\n  ')}`);
let listener = '';
try { listener = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim(); } catch (error) { if (error.status !== 1) throw error; }
if (listener) fail(`127.0.0.1:${port} 仍有监听，先查明所属进程：\n${listener}`);

let commit = option('--commit');
if (!commit) commit = execFileSync('git', ['-C', repo, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
if (!/^[0-9a-f]{7,40}$/.test(commit)) fail(`提交哈希格式不对：${commit}`);

let app = null;
if (!args.includes('--no-app') && existsSync(appPath)) {
  const read = (key) => execFileSync('plutil', ['-extract', key, 'raw', join(appPath, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
  app = { path: appPath, identifier: read('CFBundleIdentifier'), version: read('CFBundleShortVersionString'), executable: read('CFBundleExecutable') };
  if (app.identifier !== appId) fail(`${appPath} 的标识是 ${app.identifier}，不是 ${appId}`);
}

const dataEntries = walk(dataDir, new Set(['backups']));
const dataSummary = summarize(dataEntries);
const stateBytes = browserState.filter((s) => existsSync(s.path))
  .reduce((sum, s) => sum + (lstatSync(s.path).isFile() ? lstatSync(s.path).size : summarize(walk(s.path)).bytes), 0);
const appBytes = app ? summarize(walk(appPath)).bytes : 0;
const need = Math.ceil((dataSummary.bytes + stateBytes + appBytes) * 1.1);
mkdirSync(root, { recursive: true });
const { bavail, bsize } = statfsSync(root);
if (bavail * bsize < need) fail(`可用空间 ${human(bavail * bsize)}，需要约 ${human(need)}`);

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
const name = `${stamp}-${commit}`;
const final = join(root, name);
const work = join(root, `.incomplete-${name}`);
if (existsSync(final) || existsSync(work)) fail(`备份目录已存在：${final}`);
mkdirSync(work);
console.log(`备份到 ${final}（数据目录 ${human(dataSummary.bytes)}，${dataSummary.files} 个文件）`);

// 复制前记下需要安装前后一致的项目。
const checks = [];
for (const file of dbFiles) {
  const source = join(dataDir, file);
  checks.push({ source, backup: `data/${file}`, ...(existsSync(source) ? await digest(source) : { sha256: null }) });
}
for (const state of browserState.filter((s) => s.verify)) {
  checks.push({ source: state.path, backup: state.name, ...(existsSync(state.path) ? await digest(state.path) : { sha256: null }) });
}

// ditto 保留符号链接、权限和扩展属性。数据目录逐个顶层条目复制，跳过 backups/。
const ditto = (from, to) => execFileSync('ditto', [from, to], { stdio: 'inherit' });
mkdirSync(join(work, 'data'));
for (const entry of readdirSync(dataDir)) {
  if (entry === 'backups') continue;
  ditto(join(dataDir, entry), join(work, 'data', entry));
}
const copied = [];
for (const state of browserState) {
  if (!existsSync(state.path)) continue;
  ditto(state.path, join(work, state.name));
  copied.push({ name: state.name, source: state.path });
}
if (app) {
  execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, join(work, 'Dovun-before.zip')], { stdio: 'inherit' });
  app.zip = 'Dovun-before.zip';
  app.zipSha256 = await sha256(join(work, app.zip));
  execFileSync('unzip', ['-tq', join(work, app.zip)], { stdio: 'inherit' });
}

// ---------- 核对副本 ----------
const copySummary = summarize(walk(join(work, 'data')));
for (const key of ['files', 'links', 'dirs', 'bytes']) {
  if (copySummary[key] !== dataSummary[key]) fail(`data/ 的 ${key} 与来源不一致（来源 ${dataSummary[key]}，副本 ${copySummary[key]}），未完成的备份留在 ${work}`);
}
for (const item of checks) {
  const target = join(work, item.backup);
  const got = existsSync(target) ? (await digest(target)).sha256 : null;
  if (got !== item.sha256) fail(`${item.backup} 的 sha256 与来源不一致，未完成的备份留在 ${work}`);
  const again = existsSync(item.source) ? (await digest(item.source)).sha256 : null;
  if (again !== item.sha256) fail(`${item.source} 在备份过程中变了，确认 Dovun 已退出后重来；未完成的备份留在 ${work}`);
}
let quickCheck = null;
if (!existsSync(join(work, 'data/dovun.db-wal'))) {
  const uri = `file:${encodeURI(join(work, 'data/dovun.db'))}?immutable=1`;
  quickCheck = execFileSync('sqlite3', [uri, 'PRAGMA quick_check;'], { encoding: 'utf8' }).trim();
  if (quickCheck !== 'ok') fail(`副本 quick_check 未通过：${quickCheck}，未完成的备份留在 ${work}`);
}

writeFileSync(join(work, 'manifest.json'), `${JSON.stringify({
  createdAt: now.toISOString(),
  commit,
  dataDir,
  excluded: ['backups/'],
  data: dataSummary,
  quickCheck: quickCheck ?? '有 -wal，未检查',
  checks,
  copied,
  app: app ?? (args.includes('--no-app') ? '按 --no-app 未备份' : `${appPath} 不存在`),
  restore: '退出 Dovun 并确认 47317 无监听后，把 data/ 整个复制回 dataDir、浏览器状态复制回 copied 中的 source；旧应用解压 Dovun-before.zip 后整包替换 /Applications/Dovun.app。',
}, null, 2)}\n`);
renameSync(work, final);

for (const item of checks) console.log(`  ${item.sha256 ? item.sha256.slice(0, 16) : '不存在'.padEnd(16)}  ${item.backup}`);
console.log(`备份完成：${final}`);
console.log(app ? `旧应用 ${app.version}（${app.identifier}）已打包为 Dovun-before.zip` : '未打包旧应用');
console.log(`安装后核对：npm run backup:local -- --verify "${final}"`);
