import { describe, expect, it } from 'vitest';
import type { InfiniteData } from '@tanstack/react-query';
import type { ChangePage } from './api.js';
import { markChangeUndone } from './change-list-cache.js';

function page(items: ChangePage['items']): InfiniteData<ChangePage> {
  return { pages: [{ items, nextCursor: null, total: items.length }], pageParams: [null] };
}

const row = (id: string, undoneAt: string | null): ChangePage['items'][number] => ({
  id, entityType: 'task', entityId: id, operation: 'update', entityName: id, groupCount: 1,
  changeSummary: null, source: 'user', actorKind: 'user', connectionId: null, connectionName: null,
  approvalId: null, canUndo: !undoneAt, undoBlockedReason: null, undoneAt, createdAt: '2026-10-21T00:00:00.000Z',
});

describe('markChangeUndone', () => {
  it('marks one row and leaves an already undone row on its server time', () => {
    const data = page([row('a', null), row('b', '2026-01-01T00:00:00.000Z')]);
    const next = markChangeUndone(data, 'a', '2026-02-01T00:00:00.000Z');
    expect(next?.pages[0].items[0]).toMatchObject({ undoneAt: '2026-02-01T00:00:00.000Z', canUndo: false, undoBlockedReason: { code: 'CHANGE_ALREADY_UNDONE', reason: 'already_undone' } });
    expect(next?.pages[0].items[1].undoneAt).toBe('2026-01-01T00:00:00.000Z');
    expect(markChangeUndone(undefined, 'a', '2026-02-01T00:00:00.000Z')).toBeUndefined();
    expect(markChangeUndone(data, 'missing', '2026-02-01T00:00:00.000Z')).toBe(data);
  });
});
