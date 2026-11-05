// 本机 Dovun 安装备份的保留与清理。只处理备份根目录下按「日期-时间-提交」命名的备份，
// 默认只列出将删除的内容；加 --apply 才真正删除。
//
// 用法：
//   node scripts/prune-local-backups.mjs              # 预览
//   node scripts/prune-local-backups.mjs --apply      # 删除超出保留份数的旧备份
//   node scripts/prune-local-backups.mjs --keep 5     # 改保留份数（默认 3）
//   node scripts/prune-local-backups.mjs --root <目录> # 改备份根目录
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const home = homedir();
const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const apply = args.includes('--apply');
const keep = Number(option('--keep') ?? 3);
if (!Number.isInteger(keep) || keep < 1) throw new Error('--keep 必须是不小于 1 的整数');
const root = resolve(option('--root') ?? join(home, 'WorkSpace/.backups/dovun-local'));

// 备份根目录不能落在实际数据、应用或家目录本身上。
const dataDir = resolve(process.env.DOVUN_DATA_DIR ?? join(home, 'Library/Application Support/dovun'));
const inside = (child, parent) => child === parent || child.startsWith(parent + sep);
for (const guarded of [dataDir, '/Applications', join(home, 'Library/WebKit'), join(home, 'Library/Application Support/app.dovun.desktop')]) {
  if (inside(root, guarded) || inside(guarded, root)) throw new Error(`备份根目录与受保护位置重叠：${guarded}`);
}
if (root === home || root === '/') throw new Error('备份根目录不能是家目录或根目录');
if (!existsSync(root)) { console.log(`备份根目录不存在：${root}`); process.exit(0); }
if (realpathSync(root) !== root) throw new Error(`备份根目录不能是符号链接：${root}`);

const sizeKb = (path) => Number(execFileSync('du', ['-sk', path], { encoding: 'utf8' }).split('\t')[0]);
const human = (kb) => kb >= 1048576 ? `${(kb / 1048576).toFixed(1)}G` : `${Math.round(kb / 1024)}M`;
const named = /^\d{8}-\d{6}-[0-9a-f]{7,40}$/;

const entries = readdirSync(root, { withFileTypes: true });
const sets = entries.filter((e) => e.isDirectory() && named.test(e.name)).map((e) => e.name).sort().reverse();
const ignored = entries.filter((e) => !(e.isDirectory() && named.test(e.name)) && !e.name.startsWith('.')).map((e) => e.name);
const kept = sets.slice(0, keep);
const stale = sets.slice(keep);

// 至少要有一份保留下来的备份带着数据库，否则不删任何东西。
if (stale.length && !kept.some((name) => existsSync(join(root, name, 'data/dovun.db')))) {
  throw new Error('保留的备份里没有 data/dovun.db，拒绝清理旧备份');
}

console.log(`备份根目录：${root}`);
console.log(`保留最近 ${keep} 份：`);
for (const name of kept) console.log(`  保留  ${human(sizeKb(join(root, name))).padStart(6)}  ${name}`);
let freed = 0;
for (const name of stale) {
  const path = join(root, name);
  if (lstatSync(path).isSymbolicLink()) continue;
  const kb = sizeKb(path);
  freed += kb;
  console.log(`  ${apply ? '删除' : '将删'}  ${human(kb).padStart(6)}  ${name}`);
  if (apply) rmSync(path, { recursive: true });
}
if (ignored.length) console.log(`不按命名规则的条目不处理：${ignored.join('、')}`);

const legacy = [join(dataDir, 'backups'), join(home, 'Library/Application Support/dovun-release-backups')]
  .filter((path) => existsSync(path) && readdirSync(path).length);
if (legacy.length) console.log(`旧位置仍有备份，需要手动迁移或清理：${legacy.join('、')}`);

console.log(stale.length ? `${apply ? '已释放' : '可释放'} ${human(freed)}${apply ? '' : '（预览，加 --apply 执行）'}` : '没有超出保留份数的备份');
