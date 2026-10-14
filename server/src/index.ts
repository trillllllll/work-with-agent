import { app, reviewService } from './app.js';
import { DESKTOP_PORT, isDesktopPackage, isServerMode, publicWorkspaceUrl } from './application/desktop-paths.js';
import { createOwnerBootstrapToken, resolveOwnerKeyHash } from './application/security.js';
import { reconcileLocalRuns } from './application/runs.js';
import { startReviewScheduler } from './application/reviews.js';
import { recoverInterruptedUploads } from './application/library/uploads.js';
import { startLibraryWorker } from './application/library/worker.js';
import { mountDesktopStatic } from './desktop-static.js';

async function start() {
  if (isDesktopPackage() || isServerMode()) {
    // Finish a snapshot import staged by the previous process, then restore seed.zip
    // on a fresh deployment, both before the first migration touches the database.
    const { applyPendingImport, maybeSeedSnapshot } = await import('./application/snapshots.js');
    applyPendingImport();
    await maybeSeedSnapshot().catch((error) => console.error('seed 快照导入失败：', error));
    const { migrateDatabase } = await import('./db-migrate.js');
    await migrateDatabase();
  }
  // Fail fast on a malformed configured key; generate and log one only on first boot.
  if (isServerMode()) resolveOwnerKeyHash();
  if (process.env.WWA_STATIC_DIR) mountDesktopStatic(app, process.env.WWA_STATIC_DIR);

  const port = Number(process.env.PORT) || (isDesktopPackage() ? DESKTOP_PORT : 3016);
  const host = process.env.WWA_BIND_HOST ?? (isServerMode() ? '0.0.0.0' : '127.0.0.1');
  process.env.CLIENT_ORIGIN ??= isDesktopPackage()
    ? `http://127.0.0.1:${port}`
    : isServerMode()
      ? publicWorkspaceUrl()
      : 'http://127.0.0.1:5176,http://localhost:5176';
  const server = app.listen(port, host, () => {
    const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host;
    console.log(`API listening on http://${displayHost}:${port}`);
    console.log(`MCP listening on http://${displayHost}:${port}/mcp`);
    // Server mode has no launcher to hand out a one-use token; login uses the owner key instead.
    const workspace = isServerMode()
      ? publicWorkspaceUrl() || `http://${displayHost}:${port}`
      : `${process.env.CLIENT_ORIGIN!.split(',')[0].trim()}/#owner-token=${createOwnerBootstrapToken()}`;
    console.log(`Open workspace: ${workspace}`);
    void reconcileLocalRuns();
  });
  server.on('error', (error: NodeJS.ErrnoException) => {
    console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用` : error);
    process.exit(1);
  });
  if (isDesktopPackage()) {
    process.stdin.resume();
    process.stdin.on('end', () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1_500).unref();
    });
  }
  const timer = setInterval(() => { void reconcileLocalRuns(); }, 2_000);
  timer.unref();
  const stopReviews = startReviewScheduler(reviewService);
  void recoverInterruptedUploads();
  const stopLibrary = startLibraryWorker();
  const { startSnapshotScheduler } = await import('./application/snapshots.js');
  const stopSnapshots = startSnapshotScheduler();
  server.on('close', () => { clearInterval(timer); stopReviews(); stopLibrary(); stopSnapshots(); });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
