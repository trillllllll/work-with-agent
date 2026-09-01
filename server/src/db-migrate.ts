import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const migration = '20260901000000_init';
const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
const runPrisma = (args: string[]) => execFileSync(process.execPath, [prismaCli, ...args], { stdio: 'inherit' });

async function main() {
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
    if (!applied.length) runPrisma(['migrate', 'resolve', '--applied', migration, '--schema', 'prisma/schema.prisma']);
  }
  runPrisma(['migrate', 'deploy', '--schema', 'prisma/schema.prisma']);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
