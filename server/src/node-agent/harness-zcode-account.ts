import { execFile } from 'node:child_process';
import { createDecipheriv, createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { asObject, CodexRejected } from './harness-codex.js';
import { codexItems, codexText } from './harness-history.js';

const run = promisify(execFile);
const origin = 'https://zcode.z.ai';
const accountDirectory = () => resolve(process.env.ZCODE_DATA_BASE_DIR?.trim() || homedir(), '.zcode/v2');
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const unavailable = () => new CodexRejected('请在 Mac 的 ZCode 中为该项目开启网页远控');

async function deviceId() {
  if (process.platform !== 'darwin') return '';
  const path = resolve(accountDirectory(), 'setting.json');
  const stat = await lstat(path).catch(() => null);
  if (!stat?.isFile() || stat.size > 1_048_576) return '';
  const config = asObject(JSON.parse(await readFile(path, 'utf8')));
  const device = asObject(config.webRemoteControlRelayV2Device);
  return device.endpointOrigin === origin ? codexText(device.deviceSid).slice(0, 128) : '';
}

export async function zcodeRemoteConfigured() {
  try { return Boolean(await deviceId()); } catch { return false; }
}

async function accountToken() {
  const path = resolve(accountDirectory(), 'credentials.json');
  const stat = await lstat(path);
  if (!stat.isFile() || stat.mode & 0o077 || stat.size > 65_536) throw unavailable();
  const encrypted = asObject(JSON.parse(await readFile(path, 'utf8'))).zcodejwttoken;
  // Read the existing ZCode macOS key through the normal Keychain access checks. Keep
  // credentials on the Mac and send the access token only to the issuing ZCode service.
  const value = /^enc:v2:os:([a-f0-9]{24}):([\w-]{16})\.([\w-]{22})\.([\w-]+)$/.exec(codexText(encrypted));
  if (!value) throw unavailable();
  const { stdout } = await run('/usr/bin/security', [
    'find-generic-password', '-s', 'ZCode Credential Encryption', '-a', sha256(path), '-w',
  ], { encoding: 'buffer', timeout: 8_000, maxBuffer: 4_096 });
  const key = Buffer.from(stdout.toString().trim(), 'base64url');
  stdout.fill(0);
  try {
    if (key.length !== 32 || sha256(key).slice(0, 24) !== value[1]) throw unavailable();
    const ciphertext = Buffer.from(value[4], 'base64url');
    const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value[2], 'base64url'));
    cipher.setAuthTag(Buffer.from(value[3], 'base64url'));
    const token = Buffer.concat([cipher.update(ciphertext), cipher.final()]).toString('utf8').trim();
    if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) throw unavailable();
    return token;
  } finally { key.fill(0); }
}

export async function openZCodeRemoteSocket() {
  const sid = await deviceId().catch(() => '');
  if (!sid) throw unavailable();
  try {
    const token = await accountToken();
    const request = async (path: '/api/v1/remote/device' | '/api/v1/remote/token', body?: unknown) => {
      const response = await fetch(new URL(path, origin), {
        method: body ? 'POST' : 'GET', redirect: 'error', cache: 'no-store',
        headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(7_500),
      });
      if (!response.ok) throw unavailable();
      const reply = asObject(await response.json());
      if (reply.code !== 0) throw unavailable();
      return reply.data;
    };
    const device = codexItems(await request('/api/v1/remote/device')).find((row) => row.device_sid === sid);
    const mid = codexText(device?.device_mid);
    const appVersion = codexText(asObject(device?.meta).version);
    if (device?.online !== true || !mid || !appVersion) throw unavailable();
    const ticket = codexText(asObject(await request('/api/v1/remote/token', { role: 'terminal' })).token);
    if (!/^[\w-]{22}$/.test(ticket)) throw unavailable();
    const url = new URL('/api/v1/remote/ws2', origin);
    url.protocol = 'wss:';
    url.searchParams.set('token', ticket);
    url.searchParams.set('mid', mid);
    return { socket: new WebSocket(url), sid, appVersion };
  } catch { throw unavailable(); }
}
