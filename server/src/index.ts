import { app, reviewService } from './app.js';
import { createOwnerBootstrapToken } from './application/security.js';
import { reconcileLocalRuns } from './application/runs.js';
import { startReviewScheduler } from './application/reviews.js';

const port = Number(process.env.PORT) || 3016;
process.env.CLIENT_ORIGIN ??= 'http://127.0.0.1:5176,http://localhost:5176';
const server = app.listen(port, '127.0.0.1', () => {
  const origin = process.env.CLIENT_ORIGIN!.split(',')[0].trim();
  console.log(`API listening on http://127.0.0.1:${port}`);
  console.log(`MCP listening on http://127.0.0.1:${port}/mcp`);
  console.log(`Open workspace: ${origin}/#owner-token=${createOwnerBootstrapToken()}`);
  void reconcileLocalRuns();
});
const timer = setInterval(() => { void reconcileLocalRuns(); }, 2_000);
timer.unref();
const stopReviews = startReviewScheduler(reviewService);
server.on('close', () => { clearInterval(timer); stopReviews(); });
