import { describe, expect, it } from 'vitest';
import { localDateTime, reviewEditorDirty } from './ReviewQueue.js';

describe('review editor dirty state', () => {
  const item = { dueAt: null, paused: false, policy: 'manual' as const };
  it('clean when every field matches the snapshot', () => {
    expect(reviewEditorDirty('', false, 'manual', item)).toBe(false);
  });
  it('dirty when paused or policy changed', () => {
    expect(reviewEditorDirty('', true, 'manual', item)).toBe(true);
    expect(reviewEditorDirty('', false, 'spaced-v1', item)).toBe(true);
  });
  it('dirty when the date was cleared or set from a scheduled item', () => {
    const scheduled = { dueAt: '2026-01-05T01:00:00.000Z', paused: false, policy: 'manual' as const };
    const local = localDateTime(scheduled.dueAt);
    expect(reviewEditorDirty(local, false, 'manual', scheduled)).toBe(false);
    expect(reviewEditorDirty('', false, 'manual', scheduled)).toBe(true);
    expect(reviewEditorDirty('', false, 'manual', item)).toBe(false);
  });
});
