import { describe, expect, it } from 'vitest';
import { EMPTY_CHANGE_FILTERS, changeChips, changeDay, changeTimeLabel, filterCount, filtersFromQuery, filtersToPageState, filtersToQueryPatch, groupChangesByDay, hasActiveFilters, rangeToFrom, removeChangeChip, toChangeApiQuery, type ChangeFilters } from './change-filters.js';

const sample: ChangeFilters = { type: ['task', 'topic'], op: ['update', 'other'], source: ['user', 'c:conn-1'], status: ['reversible'], range: '7d', q: ' alpha ' };

describe('change filters and the hash query', () => {
  it('drops unknown tokens, empty pieces, and writes only set values', () => {
    expect(filtersFromQuery({ type: 'task, ,topic', op: 'update,nope', source: 'user,c:,bogus,c:abc', status: 'reversible,bad', range: '90d', q: '  hello  ' })).toEqual({
      type: ['task', 'topic'], op: ['update'], source: ['user', 'c:abc'], status: ['reversible'], range: 'all', q: 'hello',
    });
    expect(filtersFromQuery({})).toEqual(EMPTY_CHANGE_FILTERS);
    const patch = filtersToQueryPatch(sample);
    expect(patch).toEqual({ type: 'task,topic', op: 'update,other', source: 'user,c:conn-1', status: 'reversible', range: '7d', q: 'alpha' });
    const query = Object.fromEntries(Object.entries(patch).filter((entry): entry is [string, string] => entry[1] != null));
    expect(filtersFromQuery(query)).toEqual({ ...sample, q: 'alpha' });
    expect(filtersToQueryPatch(EMPTY_CHANGE_FILTERS)).toEqual({ type: null, op: null, source: null, status: null, range: null, q: null });
  });

  it('clips a search longer than 200 characters', () => {
    const q = 'a'.repeat(250);
    expect(filtersFromQuery({ q }).q).toHaveLength(200);
    expect(filtersToQueryPatch({ ...EMPTY_CHANGE_FILTERS, q }).q).toHaveLength(200);
  });
});

describe('range to API from', () => {
  const afternoon = new Date(2026, 9, 21, 15, 4, 5, 6);
  const midnight = new Date(2026, 9, 21, 0, 0, 0, 0);

  it('uses local midnight for today, including the boundary, and exact day spans otherwise', () => {
    expect(rangeToFrom('today', afternoon)).toBe(midnight.toISOString());
    expect(rangeToFrom('today', midnight)).toBe(midnight.toISOString());
    expect(rangeToFrom('today', new Date(2026, 9, 20, 23, 59, 59, 999))).toBe(new Date(2026, 9, 20, 0, 0, 0, 0).toISOString());
    const parsed = new Date(rangeToFrom('today', afternoon)!);
    expect([parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), parsed.getHours(), parsed.getMinutes(), parsed.getSeconds(), parsed.getMilliseconds()]).toEqual([2026, 9, 21, 0, 0, 0, 0]);
    const now = new Date('2026-10-21T15:04:05.000Z');
    expect(rangeToFrom('7d', now)).toBe(new Date(now.getTime() - 7 * 86400000).toISOString());
    expect(rangeToFrom('30d', now)).toBe(new Date(now.getTime() - 30 * 86400000).toISOString());
    expect(rangeToFrom('all', now)).toBeNull();
  });

  it('sends from instead of range, and keeps the cursor off the filter identity', () => {
    const params = new URLSearchParams(toChangeApiQuery({ ...EMPTY_CHANGE_FILTERS, type: ['task'], range: 'today', q: 'x' }, { now: afternoon, limit: 1, cursor: 'cursor-1' }));
    expect(params.get('from')).toBe(midnight.toISOString());
    expect(params.get('type')).toBe('task');
    expect(params.get('q')).toBe('x');
    expect(params.get('limit')).toBe('1');
    expect(params.get('cursor')).toBe('cursor-1');
    expect(params.has('range')).toBe(false);
    expect(toChangeApiQuery(EMPTY_CHANGE_FILTERS, { now: afternoon })).toBe('');
  });

  it('maps the same window onto page state fields', () => {
    expect(filtersToPageState(sample, afternoon)).toEqual({
      kind: 'task,topic', operation: 'update,other', source: 'user,c:conn-1', status: 'reversible', dateFrom: rangeToFrom('7d', afternoon), query: 'alpha',
    });
    expect(filtersToPageState(EMPTY_CHANGE_FILTERS, afternoon)).toEqual({});
    const longType = 't'.repeat(180);
    const state = filtersToPageState({ ...EMPTY_CHANGE_FILTERS, type: [longType, longType] }, afternoon);
    expect([...(state.kind ?? '')].length).toBe(300);
  });
});

describe('day groups', () => {
  const now = new Date(2026, 9, 21, 0, 5, 0);

  it('splits today, yesterday, and earlier on the local calendar, including midnight', () => {
    expect(changeDay(new Date(2026, 9, 21, 0, 0, 0).toISOString(), now)).toBe('today');
    expect(changeDay(new Date(2026, 9, 20, 23, 59, 59).toISOString(), now)).toBe('yesterday');
    expect(changeDay(new Date(2026, 9, 19, 23, 59, 59).toISOString(), now)).toBe('earlier');
    expect(changeDay('not-a-date', now)).toBe('earlier');
    const items = [
      { id: 'a', createdAt: new Date(2026, 9, 21, 0, 1, 0).toISOString() },
      { id: 'b', createdAt: new Date(2026, 9, 21, 8, 0, 0).toISOString() },
      { id: 'c', createdAt: new Date(2026, 9, 20, 12, 0, 0).toISOString() },
      { id: 'd', createdAt: new Date(2026, 8, 1, 0, 0, 0).toISOString() },
      { id: 'e', createdAt: new Date(2026, 8, 1, 1, 0, 0).toISOString() },
    ];
    const groups = groupChangesByDay(items, now);
    expect(groups.map((group) => [group.day, group.items.map((item) => item.id)])).toEqual([['today', ['a', 'b']], ['yesterday', ['c']], ['earlier', ['d', 'e']]]);
  });
});

describe('chips', () => {
  it('builds labeled chips and removes one without clearing the rest', () => {
    const chips = changeChips({ ...sample, q: 'alpha' }, [{ id: 'conn-1', name: 'Desk' }, { id: 'gone', name: null }]);
    expect(chips.map((chip) => [chip.id, chip.valueKey, chip.valueText])).toEqual([
      ['type:task', 'changes.entities.task', null],
      ['type:topic', 'changes.entities.topic', null],
      ['op:update', 'changes.opGroups.update', null],
      ['op:other', 'changes.opGroups.other', null],
      ['source:user', 'changes.sources.user', null],
      ['source:c:conn-1', null, 'Desk'],
      ['status:reversible', 'changes.statuses.reversible', null],
      ['range:7d', 'changes.ranges.7d', null],
      ['q', null, 'alpha'],
    ]);
    expect(changeChips({ ...EMPTY_CHANGE_FILTERS, source: ['c:gone'] })[0]).toMatchObject({ valueKey: 'changes.sources.deletedConnection', valueText: null });
    expect(changeChips({ ...EMPTY_CHANGE_FILTERS, type: ['custom_type'] })[0]).toMatchObject({ valueKey: null, valueText: 'custom_type' });
    expect(removeChangeChip(sample, 'source:c:conn-1').source).toEqual(['user']);
    expect(removeChangeChip(sample, 'type:task').type).toEqual(['topic']);
    expect(removeChangeChip(sample, 'range:7d').range).toBe('all');
    expect(removeChangeChip({ ...sample, q: 'alpha' }, 'q').q).toBe('');
    expect(removeChangeChip(sample, 'op:update').op).toEqual(['other']);
  });

  it('counts panel filters separately from a search-only query', () => {
    expect(hasActiveFilters(EMPTY_CHANGE_FILTERS)).toBe(false);
    expect(filterCount(sample)).toBe(2 + 2 + 2 + 1 + 1);
    expect(hasActiveFilters({ ...EMPTY_CHANGE_FILTERS, q: 'alpha' })).toBe(true);
    expect(filterCount({ ...EMPTY_CHANGE_FILTERS, q: 'alpha' })).toBe(0);
    expect(hasActiveFilters({ ...EMPTY_CHANGE_FILTERS, range: 'today' })).toBe(true);
  });
});

describe('changeTimeLabel', () => {
  const now = new Date(2026, 9, 21, 15, 0);
  it('shows only the clock for today and yesterday', () => {
    expect(changeTimeLabel(new Date(2026, 9, 21, 9, 5).toISOString(), 'en-GB', now)).toBe('09:05');
    expect(changeTimeLabel(new Date(2026, 9, 20, 23, 30).toISOString(), 'en-GB', now)).toBe('23:30');
  });
  it('adds the date for earlier days and the year across years', () => {
    expect(changeTimeLabel(new Date(2026, 9, 18, 8, 0).toISOString(), 'en-GB', now)).toMatch(/18 Oct.*08:00/);
    expect(changeTimeLabel(new Date(2025, 11, 31, 8, 0).toISOString(), 'en-GB', now)).toMatch(/2025/);
  });
  it('returns the raw value when unparsable', () => {
    expect(changeTimeLabel('nope', 'en-GB', now)).toBe('nope');
  });
});
