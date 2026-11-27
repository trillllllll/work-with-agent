import { describe, expect, it } from 'vitest';
import { selectRecentHarnessSession, type RecentHarnessSession } from './HarnessRecentCard.js';

function session(id: string, updatedAt: string, change: Partial<RecentHarnessSession> = {}): RecentHarnessSession {
  return {
    id, updatedAt, locationId: 'location-' + id, projectName: 'Project', nodeName: 'Mac', online: true, status: 'ready', ...change,
  };
}

describe('selectRecentHarnessSession', () => {
  it('selects the latest authorized list result across Harnesses and ignores archived rows', () => {
    const recent = session('claude-recent', '2026-11-27T10:00:00.000Z', { harness: 'claude' });
    expect(selectRecentHarnessSession([
      session('codex-pinned', '2026-11-25T10:00:00.000Z', { harness: 'codex', title: 'Older pinned' }),
      session('archived-newer', '2026-11-27T11:00:00.000Z', { archived: true }),
      recent,
    ])).toBe(recent);
  });

  it('does not invent a fallback when no session is usable', () => {
    expect(selectRecentHarnessSession([])).toBeUndefined();
    expect(selectRecentHarnessSession([session('archived', 'invalid', { archived: true })])).toBeUndefined();
  });
});
