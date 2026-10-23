import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { desktopDataDir, isDesktopPackage, isServerMode } from '../application/desktop-paths.js';
dotenv.config({ path: resolve(process.cwd(), 'server/.env') });
dotenv.config();
// A transition container keeps an existing database name; a fresh volume uses Dovun.
if (!process.env.DATABASE_URL && (isDesktopPackage() || isServerMode())) {
  const root = desktopDataDir(), current = join(root, 'dovun.db'), legacy = join(root, 'agent-studio.db');
  if (existsSync(current) && existsSync(legacy)) throw new Error('Both database names exist. Back up both and choose a source before starting.');
  process.env.DATABASE_URL = `file:${existsSync(legacy) ? legacy : current}`;
}
