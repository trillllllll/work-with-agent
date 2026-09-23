import { app, reviewService } from './app.js';
import { DESKTOP_PORT, isDesktopPackage } from './application/desktop-paths.js';
import { createOwnerBootstrapToken } from './application/security.js';
import { reconcileLocalRuns } from './application/runs.js';
import { startReviewScheduler } from './application/reviews.js';
import { mountDesktopStatic } from './desktop-static.js';

async function start() {
  if (isDesktopPackage()) {
    const { migrateDatabase } = await import('./db-migrate.js');
    await migrateDatabase();
    if (process.env.WWA_STATIC_DIR) mountDesktopStatic(app, process.env.WWA_STATIC_DIR);
  }

  const port = Number(process.env.PORT) || (isDesktopPackage() ? DESKTOP_PORT : 3016);
  process.env.CLIENT_ORIGIN ??= isDesktopPackage()
    ? `http://127.0.0.1:${port}`
    : 'http://127.0.0.1:5176,http://localhost:5176';
  const server = app.listen(port, '127.0.0.1', () => {
    const origin = process.env.CLIENT_ORIGIN!.split(',')[0].trim();
    console.log(`API listening on http://127.0.0.1:${port}`);
    console.log(`MCP listening on http://127.0.0.1:${port}/mcp`);
    console.log(`Open workspace: ${origin}/#owner-token=${createOwnerBootstrapToken()}`);
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
  server.on('close', () => { clearInterval(timer); stopReviews(); });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
