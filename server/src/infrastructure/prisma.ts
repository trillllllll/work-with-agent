import dotenv from 'dotenv';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';

dotenv.config({ path: resolve(process.cwd(), 'server/.env') });
dotenv.config();

export function sqliteConnectionUrl(url: string) {
  if (!url.startsWith('file:')) return url;
  const separator = url.indexOf('?');
  const path = separator < 0 ? url : url.slice(0, separator);
  const params = new URLSearchParams(separator < 0 ? '' : url.slice(separator + 1));
  // SQLite has one writer. Multiple native connections can exhaust the engine
  // workers waiting for its write lock, including the transaction holding it.
  params.set('connection_limit', '1');
  return `${path}?${params}`;
}

const datasourceUrl = process.env.DATABASE_URL;
export const prisma = new PrismaClient(datasourceUrl ? { datasourceUrl: sqliteConnectionUrl(datasourceUrl) } : undefined);
