import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const migration = '20260901000000_init';
const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
const schema = fileURLToPath(new URL('../prisma/schema.prisma', import.meta.url));

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return realpathSync(entry) === fileURLToPath(import.meta.url); }
  catch { return false; }
}

export async function migrateDatabase(datasourceUrl = process.env.DATABASE_URL) {
  if (!datasourceUrl) throw new Error('DATABASE_URL is required');
  const prisma = new PrismaClient({ datasourceUrl });
  const runPrisma = (args: string[]) => execFileSync(process.execPath, [prismaCli, ...args, '--schema', schema], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: datasourceUrl },
  });
  try {
    // Existing MVP databases already contain the initial schema. Mark the first
    // migration as applied so they can continue without a destructive reset.
    const tables = await prisma.$queryRaw<Array<{ name: string }>>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'topics'
    `;
    if (tables.length > 0) {
      // The pre-Prisma MVP stored JavaScript epoch milliseconds in DateTime
      // columns. Normalize those legacy values before Prisma reads them.
      for (const table of ['topics', 'tasks', 'conversations', 'approvals']) {
        await prisma.$executeRawUnsafe(`UPDATE "${table}" SET created_at = datetime(CAST(created_at AS INTEGER) / 1000, 'unixepoch') WHERE CAST(created_at AS INTEGER) > 100000000000`);
        await prisma.$executeRawUnsafe(`UPDATE "${table}" SET updated_at = datetime(CAST(updated_at AS INTEGER) / 1000, 'unixepoch') WHERE CAST(updated_at AS INTEGER) > 100000000000`);
      }
      await prisma.$executeRawUnsafe(`UPDATE "messages" SET created_at = datetime(CAST(created_at AS INTEGER) / 1000, 'unixepoch') WHERE CAST(created_at AS INTEGER) > 100000000000`);
      const historyTable = await prisma.$queryRaw<Array<{ name: string }>>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_prisma_migrations'
      `;
      const applied = historyTable.length
        ? await prisma.$queryRaw<Array<{ migration_name: string }>>`SELECT migration_name FROM _prisma_migrations WHERE migration_name = ${migration}`
        : [];
      if (!applied.length) runPrisma(['migrate', 'resolve', '--applied', migration]);
    }
    runPrisma(['migrate', 'deploy']);
  } finally {
    await prisma.$disconnect();
  }
}

if (isDirectRun()) {
  migrateDatabase().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
