// Helpers for the DSH stub and its tests: write session logs in dsh's on-disk layout without a zstd encoder.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const BLOCK = 65_536;

/** One zstd frame that stores its payload in uncompressed raw blocks; any zstd decoder accepts it. */
export function rawFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  // Magic, a header with the single-segment flag and a 4-byte content size, then the blocks.
  const header = Buffer.alloc(9);
  MAGIC.copy(header, 0);
  header[4] = 0xa0;
  header.writeUInt32LE(payload.length, 5);
  const parts = [header];
  for (let at = 0; at < payload.length; at += BLOCK) {
    const block = payload.subarray(at, at + BLOCK);
    const value = (block.length << 3) | (at + BLOCK >= payload.length ? 1 : 0);
    parts.push(Buffer.from([value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0x7f]), block);
  }
  if (!payload.length) parts.push(Buffer.from([1, 0, 0]));
  return Buffer.concat(parts);
}

/** dsh's project directory name for a path, ported from its session persistence. */
export function projectKey(cwd) {
  let readable = '';
  let separator = false;
  for (let index = 0; index < cwd.length; index++) {
    const code = cwd.charCodeAt(index);
    const character = String.fromCharCode(code);
    if (character === '/' || character === '\\' || character === ':') {
      if (!separator) readable += '-';
      separator = true;
    } else if (character !== '~' && /^[A-Za-z0-9._-]$/.test(character)) {
      readable += character;
      separator = false;
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
      separator = false;
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root';
  return `--${slug.slice(0, 251)}--`;
}

export function sessionDirectory(home, cwd, id) {
  return join(home, 'sessions', projectKey(cwd), id);
}

/** Append each record as its own frame, which is how dsh writes a log. */
export function appendRecords(directory, records) {
  appendFileSync(join(directory, 'session.v4.jsonl.zstd'), Buffer.concat(records.map((record) => rawFrame(JSON.stringify(record) + '\n'))));
}

export const projection = (cwd, { title = '', lastPromptAt = 0, preset = 'workspace-write', createdAt = Date.now() } = {}) => ({
  version: 1,
  record: {
    identity: { formatVersion: 4, createdAt, cwd, isSeeded: false, inheritedEventCount: 0 },
    rows: {
      title: { val: title },
      sessionListMetadata: { val: { blank: !lastPromptAt, lastPromptAt } },
      permissions: { val: { preset } },
    },
  },
});

/** Lay out one stored session the way dsh keeps it: a framed log, its lock file and the projection cache entry. */
export function writeSession(home, { cwd, id, records, ...cache }) {
  const directory = sessionDirectory(home, cwd, id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'session.v4.jsonl.zstd'), Buffer.concat(records.map((record) => rawFrame(JSON.stringify(record) + '\n'))));
  writeFileSync(join(directory, 'session.lock'), '');
  const projections = join(home, 'storages', 'session_projcache', 'sessions');
  mkdirSync(projections, { recursive: true });
  writeFileSync(join(projections, `${id}.json`), JSON.stringify(projection(cwd, cache)));
  return directory;
}
