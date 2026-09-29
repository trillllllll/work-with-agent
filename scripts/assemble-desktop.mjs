import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { chmod, cp, mkdir, rm } from 'node:fs/promises';
import { get } from 'node:https';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

const nodeVersion = '22.13.0';
const root = resolve(import.meta.dirname, '..');
const resources = resolve(root, 'desktop/resources');
const serverDir = resolve(resources, 'server');
const runtimePackages = ['@modelcontextprotocol/sdk', '@prisma/client', 'cors', 'dotenv', 'express', 'zod', 'prisma'];
const platform = process.platform;
const arch = process.arch;
const target = platform === 'darwin' && arch === 'arm64'
  ? {
      kind: 'darwin',
      archive: `node-v${nodeVersion}-darwin-arm64.tar.gz`,
      extractDir: `node-v${nodeVersion}-darwin-arm64`,
      nodePath: 'bin/node',
    }
  : platform === 'win32' && arch === 'x64'
    ? {
        kind: 'windows',
        archive: `node-v${nodeVersion}-win-x64.zip`,
        extractDir: `node-v${nodeVersion}-win-x64-extracted`,
        nodePath: `node-v${nodeVersion}-win-x64/node.exe`,
      }
    : null;
const npmCommand = platform === 'win32' ? 'npm.cmd' : 'npm';

if (!target) {
  console.error('桌面组装目前只支持 macOS Apple Silicon 和 Windows x64');
  process.exit(1);
}
if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error(`需要 Node.js 22 来组装桌面应用，当前是 ${process.version}`);
  process.exit(1);
}

function installedVersion(name) {
  for (const base of [resolve(root, 'node_modules', name), resolve(root, 'server/node_modules', name)]) {
    try { return JSON.parse(readFileSync(resolve(base, 'package.json'), 'utf8')).version; }
    catch { /* Look in the other install location. */ }
  }
  throw new Error(`找不到已安装的 ${name}。先在仓库根目录执行 npm install`);
}

function run(command, args, cwd) {
  if (platform === 'win32' && command.endsWith('.cmd')) {
    execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command, ...args], { cwd, stdio: 'inherit', env: process.env });
    return;
  }
  execFileSync(command, args, { cwd, stdio: 'inherit', env: process.env });
}

console.log('构建服务端和客户端…');
run(npmCommand, ['run', 'build'], root);

await mkdir(resources, { recursive: true });
await ensureNode();

const dependencies = Object.fromEntries(runtimePackages.map((name) => [name, installedVersion(name)]));
const manifest = {
  name: 'work-with-agent-server',
  private: true,
  type: 'module',
  dependencies,
};
const stamp = `${JSON.stringify(manifest)}\n`;
const stampPath = resolve(serverDir, '.deps-stamp');
await mkdir(serverDir, { recursive: true });
const installed = existsSync(stampPath) && readFileSync(stampPath, 'utf8') === stamp && existsSync(resolve(serverDir, 'node_modules/prisma/build/index.js'));
if (!installed) {
  console.log('安装桌面运行依赖…');
  await rm(resolve(serverDir, 'node_modules'), { recursive: true, force: true });
  writeFileSync(resolve(serverDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  run(npmCommand, ['install', '--omit=dev', '--no-package-lock'], serverDir);
  writeFileSync(stampPath, stamp);
}

await mkdir(resolve(serverDir, 'prisma'), { recursive: true });
await cp(resolve(root, 'server/prisma/schema.prisma'), resolve(serverDir, 'prisma/schema.prisma'));
await rm(resolve(serverDir, 'prisma/migrations'), { recursive: true, force: true });
await cp(resolve(root, 'server/prisma/migrations'), resolve(serverDir, 'prisma/migrations'), { recursive: true });
await rm(resolve(serverDir, 'dist'), { recursive: true, force: true });
await cp(resolve(root, 'server/dist'), resolve(serverDir, 'dist'), { recursive: true });
await rm(resolve(resources, 'client'), { recursive: true, force: true });
await cp(resolve(root, 'client/dist'), resolve(resources, 'client'), { recursive: true });
run(process.execPath, [resolve(serverDir, 'node_modules/prisma/build/index.js'), 'generate', '--schema', resolve(serverDir, 'prisma/schema.prisma')], serverDir);
console.log(`桌面运行时已组装到 ${resources}`);

async function ensureNode() {
  const binary = resolve(resources, 'node.exe');
  if (existsSync(binary)) {
    try {
      const version = execFileSync(binary, ['-p', 'process.version'], { encoding: 'utf8' }).trim();
      if (version === `v${nodeVersion}`) return;
    } catch { /* Replace a damaged or older binary. */ }
  }
  const archive = resolve(tmpdir(), target.archive);
  if (!existsSync(archive)) {
    console.log(`下载 Node.js ${nodeVersion}…`);
    await download(`https://nodejs.org/dist/v${nodeVersion}/${target.archive}`, archive);
  }
  const extractDir = resolve(tmpdir(), target.extractDir);
  await rm(extractDir, { recursive: true, force: true });
  if (target.kind === 'darwin') {
    run('tar', ['-xzf', archive, '-C', tmpdir()], tmpdir());
    await cp(resolve(tmpdir(), target.extractDir, target.nodePath), binary);
    await chmod(binary, 0o755);
    try { run('xattr', ['-c', binary], resources); } catch { /* A freshly extracted binary may have no quarantine attribute. */ }
    run('codesign', ['--force', '--sign', '-', binary], resources);
    return;
  }

  run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Expand-Archive -LiteralPath ${powershellQuote(archive)} -DestinationPath ${powershellQuote(extractDir)} -Force`,
  ], tmpdir());
  await cp(resolve(extractDir, target.nodePath), binary);
}

function powershellQuote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function download(url, destination) {
  return new Promise((resolvePromise, reject) => {
    get(url, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        const next = new URL(response.headers.location, url).href;
        download(next, destination).then(resolvePromise, reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`下载 Node.js 失败：${url}（${response.statusCode}）`));
        response.resume();
        return;
      }
      pipeline(response, createWriteStream(destination)).then(resolvePromise, reject);
    }).on('error', reject);
  });
}
