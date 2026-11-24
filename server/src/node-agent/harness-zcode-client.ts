import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { providerEnvironment } from '../runner/environment.js';
import { runtimeEnv } from '../shared/runtime-env.js';
import { CodexAppServer, CodexRejected, type HarnessNotification } from './harness-codex.js';

const exec = promisify(execFile);
const helper = 'Frameworks/ZCode Helper.app/Contents/MacOS/ZCode Helper';
const bundle = 'Resources/glm/zcode.cjs';

export function zcodeWorkspace(cwd: string) {
  return { workspacePath: cwd, workspaceKey: cwd };
}

export function zcodeDataHome(env: NodeJS.ProcessEnv = process.env) {
  return env.ZCODE_DATA_BASE_DIR?.trim() || homedir();
}

async function zcodeAccountHost(installation: string) {
  const dir = runtimeEnv('ZCODE_ACCOUNT_HOST_DIR')?.trim()
    || fileURLToPath(new URL('../../zcode-account-host/', import.meta.url));
  const script = resolve(dir, 'zcode.cjs');
  try {
    const manifest = JSON.parse(await readFile(resolve(dir, 'manifest.json'), 'utf8'));
    const [{ stdout }] = await Promise.all([
      exec('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', resolve(installation, 'Info.plist')], { timeout: 2_000 }),
      access(script, constants.R_OK),
      access(resolve(dir, 'provider/zcode-builtin.json'), constants.R_OK),
    ]);
    if (manifest.version === stdout.trim()) return script;
  } catch { /* The stock CLI still supports the personal provider catalogue. */ }
}

export async function resolveZCode(accountAware = false) {
  const configured = runtimeEnv('ZCODE_BIN');
  const env = providerEnvironment();
  delete env.DOVUN_NODE_TOKEN;
  const home = zcodeDataHome(env);
  env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE ||= resolve(home, '.zcode/v2/provider_config.json');
  if (configured) {
    const script = resolve(configured);
    await access(script, constants.R_OK);
    return { node: process.execPath, script, env, home };
  }
  if (process.platform === 'darwin') {
    for (const root of ['/Applications/ZCode.app/Contents', resolve(homedir(), 'Applications/ZCode.app/Contents')]) {
      const script = resolve(root, bundle);
      const node = resolve(root, helper);
      const builtIn = resolve(root, 'Resources/config/provider/zcode-builtin.json');
      try {
        await Promise.all([access(script, constants.R_OK), access(node, constants.X_OK), access(builtIn, constants.R_OK)]);
      } catch { continue; }
      // Use the installed app's Node and SQLite versions for its session store.
      const accountHost = accountAware ? await zcodeAccountHost(root) : undefined;
      if (accountHost) {
        env.ELECTRON_RUN_AS_NODE = '1';
        env.NODE_PATH = resolve(root, 'Resources/app.asar/node_modules');
        env.DOVUN_ZCODE_BUNDLED_CLI = script;
        const credentials = resolve(home, '.zcode/v2/dovun-account/credentials.json');
        if (!env.ZCODE_CREDENTIALS_FILE && await access(credentials, constants.R_OK).then(() => true, () => false)) {
          env.ZCODE_CREDENTIALS_FILE = credentials;
        }
        // Let ZCode resolve its current, versioned provider cache and fall back to the bundled catalogue.
        delete env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
        return { node, script: accountHost, env, home };
      }
      return { node, script, home, env: { ...env, ELECTRON_RUN_AS_NODE: '1', ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtIn } };
    }
  }
  throw new CodexRejected('本机未找到支持会话接入的 ZCode');
}

export async function zcodeAvailable() {
  try {
    const { node, script, env } = await resolveZCode();
    const { stdout } = await exec(node, [script, '--version'], { env, timeout: 5_000, windowsHide: true });
    const version = /^(?:zcode\s+)?(\d+)\.(\d+)\.\d+$/i.exec(stdout.trim());
    return !!version && (Number(version[1]) > 0 || Number(version[2]) >= 18);
  } catch { return false; }
}

export async function openZCode(cwd: string, onMessage: HarnessNotification, onExit: () => void, accountAware = false) {
  const { node, script, env } = await resolveZCode(accountAware);
  const child = spawn(node, [script, 'app-server', '--surface', 'desktop'], { cwd, env, windowsHide: true, stdio: 'pipe' });
  const app = CodexAppServer.fromStdio(child, (method, params, id) => {
    if (id === undefined) { onMessage(method, params); return; }
    // The CLI obtains its policies from local config. Host-only search requires a separate integration.
    const response = method === 'session/requestRuntimePreferences'
      ? app.reply(id, { nativeSearchEnhancementsEnabled: false })
      : method === 'session/readReplyLanguage' ? app.reply(id, { language: null }) : app.unsupported(id);
    void response.catch(() => undefined);
  }, onExit, 'ZCode');
  return app;
}

export async function withZCode<T>(cwd: string, action: (app: CodexAppServer) => Promise<T>) {
  const app = await openZCode(cwd, () => undefined, () => undefined);
  try { return await action(app); }
  finally { await app.close(); }
}
