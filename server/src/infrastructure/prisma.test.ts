import { describe, expect, it } from 'vitest';
import { sqliteConnectionUrl } from './prisma.js';

describe('SQLite writer connection limit', () => {
  it('serializes the native pool without changing the database path', () => {
    expect(sqliteConnectionUrl('file:../data/test.db')).toBe('file:../data/test.db?connection_limit=1');
    expect(sqliteConnectionUrl('file:/a path/db.db?socket_timeout=5&connection_limit=8')).toBe('file:/a path/db.db?socket_timeout=5&connection_limit=1');
    expect(sqliteConnectionUrl('file:/db.db?connection_limit=1&connection_limit=3')).toBe('file:/db.db?connection_limit=1');
  });
  it('does not rewrite a non-SQLite URL', () => {
    expect(sqliteConnectionUrl('postgresql://localhost/db?connection_limit=8')).toBe('postgresql://localhost/db?connection_limit=8');
  });
});
