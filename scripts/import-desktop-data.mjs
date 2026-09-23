import { cp, mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);

function flag(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} 需要一个路径`);
  return value;
}

const sourceDir = resolve(flag('--source-dir', resolve(root, 'server/data')));
const dataDir = resolve(flag('--data-dir', resolve(homedir(), 'Library/Application Support/work-with-agent')));
const sourceDb = resolve(sourceDir, 'agent-studio.db');
const destinationDb = resolve(dataDir, 'agent-studio.db');

await stat(sourceDb).catch((error) => {
  if (error?.code === 'ENOENT') throw new Error(`找不到来源数据库：${sourceDb}`);
  throw error;
});
try {
  await stat(destinationDb);
  console.error(`目标数据库已存在，拒绝覆盖：${destinationDb}`);
  process.exit(1);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

await mkdir(dataDir, { recursive: true });
await cp(sourceDb, destinationDb);
const blobs = resolve(sourceDir, 'knowledge-blobs');
try {
  const info = await stat(blobs);
  if (info.isDirectory()) await cp(blobs, resolve(dataDir, 'knowledge-blobs'), { recursive: true });
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
console.log(`已导入到 ${dataDir}`);
