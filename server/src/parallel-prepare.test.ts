import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isolateImportedBindings } from './parallel-prepare.js';
describe('independent copied workspace', () => {
  it('archives bindings and pauses imported automation once, preserving later intentional changes', async () => {
    const data = await mkdtemp(join(tmpdir(), 'dovun-bindings-'));
    try {
      await mkdir(join(data, 'node')); await writeFile(join(data, 'node/config.json'), '{"fixture":true}'); await writeFile(join(data, 'sync-device.json'), '{"fixture":true}');
      await writeFile(join(data, '.dovun-migration.json'), '{"source":"/old"}');
      const db = new DatabaseSync(join(data, 'dovun.db'));
      db.exec('CREATE TABLE ReviewRule (enabled INTEGER); CREATE TABLE AutoMemoryScope (enabled INTEGER); CREATE TABLE Artifact (id TEXT, path TEXT); INSERT INTO ReviewRule VALUES (1); INSERT INTO AutoMemoryScope VALUES (1); INSERT INTO Artifact VALUES (\'a\',\'/old/runner/output\'),(\'b\',\'/outside/document\')');
      await isolateImportedBindings(data);
      expect(await readdir(join(data, 'node'))).not.toContain('config.json');
      expect(await readFile(join(data, 'migration-disabled-bindings/node-config.json'), 'utf8')).toContain('fixture');
      expect(db.prepare('SELECT enabled FROM ReviewRule').get()!.enabled).toBe(0);
      expect(db.prepare('SELECT path FROM Artifact WHERE id=\'a\'').get()!.path).toBe(data + '/runner/output');
      expect(db.prepare('SELECT path FROM Artifact WHERE id=\'b\'').get()!.path).toBe('/outside/document');
      db.exec('UPDATE ReviewRule SET enabled=1'); await writeFile(join(data, 'node/config.json'), 'new independent pairing');
      await isolateImportedBindings(data);
      expect(db.prepare('SELECT enabled FROM ReviewRule').get()!.enabled).toBe(1);
      expect(await readFile(join(data, 'node/config.json'), 'utf8')).toBe('new independent pairing'); db.close();
    } finally { await rm(data, { recursive: true, force: true }); }
  });
});
