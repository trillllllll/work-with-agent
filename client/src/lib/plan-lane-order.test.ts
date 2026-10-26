import { describe, expect, it } from 'vitest';
import { loadPlanLaneOrders, movePlanLaneOrder, planLaneOrderStorageKey, savePlanLaneOrder } from './plan-lane-order.js';

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

describe('plan lane order storage', () => {
  it('round-trips exact group orders', () => {
    const storage = memoryStorage();
    savePlanLaneOrder('2026-10-26:600:a,b', ['b', 'a'], storage, 10);
    expect(loadPlanLaneOrders(storage)).toEqual({ '2026-10-26:600:a,b': ['b', 'a'] });
  });

  it('falls back to empty orders for malformed or incompatible data', () => {
    expect(loadPlanLaneOrders(memoryStorage({ [planLaneOrderStorageKey]: '{broken' }))).toEqual({});
    expect(loadPlanLaneOrders(memoryStorage({ [planLaneOrderStorageKey]: JSON.stringify({ version: 2, entries: {} }) }))).toEqual({});
    expect(loadPlanLaneOrders(undefined)).toEqual({});
  });

  it('sanitizes invalid entries and duplicate task ids', () => {
    const storage = memoryStorage({ [planLaneOrderStorageKey]: JSON.stringify({ version: 1, entries: {
      valid: { taskIds: ['a', 'a', '', 3, 'b'], updatedAt: 1 },
      invalid: { taskIds: 'a', updatedAt: 2 },
      stale: { taskIds: ['c'], updatedAt: 'old' },
    } }) });
    expect(loadPlanLaneOrders(storage)).toEqual({ valid: ['a', 'b'] });
  });

  it('trims the least recently updated groups', () => {
    const storage = memoryStorage();
    savePlanLaneOrder('old', ['a'], storage, 1, 2);
    savePlanLaneOrder('middle', ['b'], storage, 2, 2);
    savePlanLaneOrder('new', ['c'], storage, 3, 2);
    expect(loadPlanLaneOrders(storage)).toEqual({ middle: ['b'], new: ['c'] });
  });

  it('preserves session orders across writes when storage fails', () => {
    const storage = { getItem: () => null, setItem: () => { throw new Error('full'); } };
    const first = savePlanLaneOrder('first', ['b', 'a'], storage);
    expect(savePlanLaneOrder('second', ['d', 'c'], storage, Date.now(), 100, first)).toEqual({ first: ['b', 'a'], second: ['d', 'c'] });
  });
});

describe('plan lane reordering', () => {
  it('moves a task before or after its target without changing other ids', () => {
    expect(movePlanLaneOrder(['a', 'b', 'c'], 'c', 'a', 'before')).toEqual(['c', 'a', 'b']);
    expect(movePlanLaneOrder(['a', 'b', 'c'], 'a', 'b', 'after')).toEqual(['b', 'a', 'c']);
    expect(movePlanLaneOrder(['a', 'b'], 'a', 'a', 'after')).toEqual(['a', 'b']);
    expect(movePlanLaneOrder(['a', 'b'], 'missing', 'a', 'before')).toEqual(['a', 'b']);
  });
});
