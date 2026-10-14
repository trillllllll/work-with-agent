import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Router } from 'express';
import { DomainError } from '../domain/task.js';
import { ownerMiddleware } from '../application/security.js';
import { createSnapshot, importSnapshot, listSnapshots, scheduleRestart, snapshotFileName, streamToDisk } from '../application/snapshots.js';

/** A personal workspace is a database plus hash-addressed blobs; 2 GiB of zip covers it with room to spare. */
const snapshotUploadLimit = 2 * 1024 * 1024 * 1024;

export function createServerRouter() {
  const router = Router();
  router.use(ownerMiddleware);
  router.get('/snapshot', async (_req, res, next) => {
    try {
      const { bytes, manifest } = await createSnapshot();
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${snapshotFileName(manifest)}"`);
      res.send(bytes);
    } catch (error) { next(error); }
  });
  router.get('/snapshots', async (_req, res, next) => {
    try { res.json({ data: await listSnapshots(), error: null }); } catch (error) { next(error); }
  });
  router.put('/snapshot/import', async (req, res, next) => {
    try {
      const contentType = req.headers['content-type']?.split(';')[0];
      if (contentType !== 'application/zip' && contentType !== 'application/octet-stream') {
        throw new DomainError('VALIDATION_ERROR', '请以 application/zip 原始字节上传快照', 400);
      }
      const requested = Array.isArray(req.query.mode) ? req.query.mode[0] : req.query.mode;
      if (requested !== undefined && requested !== 'merge' && requested !== 'replace') {
        throw new DomainError('VALIDATION_ERROR', 'mode 只能是 merge 或 replace', 400);
      }
      const mode = requested === 'merge' ? 'merge' : 'replace';
      const staging = await mkdtemp(join(tmpdir(), 'wwa-snapshot-import-'));
      try {
        const uploaded = join(staging, 'snapshot.zip');
        await streamToDisk(req, uploaded, snapshotUploadLimit);
        const result = await importSnapshot(await readFile(uploaded), { mode });
        res.json({
          data: {
            imported: true,
            mode: result.mode,
            inserted: result.inserted,
            skipped: result.skipped,
            snapshotVersion: result.manifest.appVersion,
            schemaVersion: result.manifest.schemaVersion,
          },
          error: null,
        });
        // Replace swaps the database file at the next startup. Merge writes into the open file.
        if (mode === 'replace') scheduleRestart();
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    } catch (error) { next(error); }
  });
  return router;
}
