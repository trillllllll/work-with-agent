import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const upstreamCommit = 'a4b4445141eb7d3b3e99eada9292775383bfc44e';
const projectRoot = resolve(import.meta.dirname, '../..');
const [checkout, destination = resolve(projectRoot, '.cache/zcode-account-host')] = process.argv.slice(2);
if (!checkout || Number(process.versions.node.split('.')[0]) < 24) {
  throw new Error('用 Node 24 运行 node scripts/zcode-account-host/build.mjs <ZCode v4.0.0 临时检出目录> [产物目录]');
}

const cwd = resolve(checkout);
const patch = resolve(import.meta.dirname, 'upstream.patch');
const pnpm = ['--yes', '--package', 'pnpm@10.33.2', 'pnpm'];
const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const run = (...args) => execFileSync('npx', [...pnpm, ...args], { cwd, stdio: 'inherit' });

if (git('rev-parse', 'HEAD') !== upstreamCommit || git('status', '--porcelain', '--untracked-files=no')) {
  throw new Error('请使用 ZCode v4.0.0 对应提交的干净临时检出目录');
}
git('apply', '--check', patch);
git('apply', patch);
try {
  run('install', '--filter', '@zcode/cli...', '--frozen-lockfile', '--ignore-scripts', '--fetch-retries=1', '--fetch-timeout=20000');
  run('--filter', '@zcode/cli^...', '--filter', '!@zcode/tui', '-r', '--workspace-concurrency=2', 'run', 'build');
  run('--filter', '@zcode/cli', 'run', 'build:desktop-agent');

  const dist = resolve(cwd, 'apps/zcode-cli/packages/cli/dist');
  const output = resolve(destination);
  const { version } = JSON.parse(await readFile(resolve(cwd, 'package.json'), 'utf8'));
  const sha256 = createHash('sha256').update(await readFile(resolve(dist, 'zcode.cjs'))).digest('hex');
  const patchSha256 = createHash('sha256').update(await readFile(patch)).digest('hex');
  await mkdir(resolve(output, 'provider'), { recursive: true });
  await copyFile(resolve(dist, 'zcode.cjs'), resolve(output, 'zcode.cjs'));
  await copyFile(resolve(dist, 'provider/zcode-builtin.json'), resolve(output, 'provider/zcode-builtin.json'));
  await copyFile(resolve(dist, 'THIRD-PARTY-NOTICES.md'), resolve(output, 'THIRD-PARTY-NOTICES.md'));
  await copyFile(resolve(cwd, 'LICENSE'), resolve(output, 'LICENSE'));
  await writeFile(resolve(output, 'manifest.json'), JSON.stringify({ version, upstreamCommit, sha256, patchSha256 }) + '\n');
  console.log(output);
} finally {
  git('apply', '--reverse', patch);
}
