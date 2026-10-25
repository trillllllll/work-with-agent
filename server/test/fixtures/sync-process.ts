// Native integration fixture: each process has its own SQLite database and binding directory.
import { app } from '../../src/app.js';
import { createOwnerBootstrapToken } from '../../src/application/security.js';
import { startReplicaSync } from '../../src/application/sync-replica.js';
import { prisma } from '../../src/infrastructure/prisma.js';

const stopSync = startReplicaSync();
const listener = app.listen(Number(process.env.SYNC_TEST_PORT ?? 0), '127.0.0.1', () => {
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('Missing test address');
  process.stdout.write(JSON.stringify({ port: address.port, bootstrap: createOwnerBootstrapToken() }) + '\n');
});
process.on('SIGTERM', () => {
  stopSync();
  listener.closeAllConnections();
  listener.close(() => { void prisma.$disconnect().finally(() => process.exit(0)); });
});
