/** Filter state for the change history page. URL uses `range`; the API uses `from`. */

export const CHANGE_ENTITY_TYPES = ['task', 'topic', 'tag', 'execution', 'memory', 'material', 'skill', 'workspace', 'proposal', 'entity', 'graphLink', 'libraryFolder', 'libraryTag', 'handoff', 'run', 'code_application'] as const;
export const CHANGE_OP_GROUPS = ['create', 'update', 'delete', 'restore', 'summary', 'execute', 'undo', 'other'] as const;
export const CHANGE_STATUSES = ['reversible', 'undone', 'blocked'] as const;
export const CHANGE_RANGES = ['all', 'today', '7d', '30d'] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_QUERY = 200;
/** Chat context `pageState` strings are capped at 300 characters. */
const MAX_PAGE_STATE = 300;

export type ChangeEntityType = (typeof CHANGE_ENTITY_TYPES)[number];
export type ChangeOpGroup = (typeof CHANGE_OP_GROUPS)[number];
export type ChangeStatusFilter = (typeof CHANGE_STATUSES)[number];
export type ChangeDateRange = (typeof CHANGE_RANGES)[number];
export type ChangeDay = 'today' | 'yesterday' | 'earlier';

export type ChangeFilters = {
  type: string[];
  op: ChangeOpGroup[];
  source: string[];
  status: ChangeStatusFilter[];
  range: ChangeDateRange;
  q: string;
};

export const EMPTY_CHANGE_FILTERS: ChangeFilters = { type: [], op: [], source: [], status: [], range: 'all', q: '' };

export type ChangeChipDimension = 'type' | 'op' | 'source' | 'status' | 'range' | 'q';
export type ChangeChip = {
  id: string;
  dimension: ChangeChipDimension;
  value: string;
  /** i18n key for the dimension name, under the settings namespace. */
  nameKey: string;
  /** i18n key for a known value. Null when `valueText` is the label. */
  valueKey: string | null;
  valueText: string | null;
};

export type ChangeConnectionOption = { id: string; name: string | null };

export type ChangePageState = {
  kind?: string;
  operation?: string;
  source?: string;
  status?: string;
  dateFrom?: string;
  query?: string;
};

function isOneOf<T extends string>(values: readonly T[], token: string): token is T {
  return (values as readonly string[]).includes(token);
}

function uniqueTokens(value: string | undefined) {
  if (!value) return [];
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const part of value.split(',')) {
    const token = part.trim();
    if (!token || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

function isSourceToken(token: string) {
  return token === 'user' || token === 'assistant' || (token.startsWith('c:') && token.length > 2);
}

function clipQuery(value: string) {
  const chars = [...value.trim()];
  return chars.length > MAX_QUERY ? chars.slice(0, MAX_QUERY).join('') : chars.join('');
}

function clipPageState(value: string) {
  const chars = [...value];
  return chars.length > MAX_PAGE_STATE ? chars.slice(0, MAX_PAGE_STATE).join('') : value;
}

export function filtersFromQuery(query: Record<string, string | undefined>): ChangeFilters {
  return {
    type: uniqueTokens(query.type),
    op: uniqueTokens(query.op).filter((token): token is ChangeOpGroup => isOneOf(CHANGE_OP_GROUPS, token)),
    source: uniqueTokens(query.source).filter(isSourceToken),
    status: uniqueTokens(query.status).filter((token): token is ChangeStatusFilter => isOneOf(CHANGE_STATUSES, token)),
    range: query.range && isOneOf(CHANGE_RANGES, query.range) ? query.range : 'all',
    q: clipQuery(query.q ?? ''),
  };
}

/** Null values are omitted by `useHashRoute().setQuery`. */
export function filtersToQueryPatch(filters: ChangeFilters): Record<string, string | null> {
  const q = clipQuery(filters.q);
  return {
    type: filters.type.length ? filters.type.join(',') : null,
    op: filters.op.length ? filters.op.join(',') : null,
    source: filters.source.length ? filters.source.join(',') : null,
    status: filters.status.length ? filters.status.join(',') : null,
    range: filters.range === 'all' ? null : filters.range,
    q: q || null,
  };
}

/** Local midnight for today. 7 and 30 days are `now` minus that many 24-hour spans. */
export function rangeToFrom(range: ChangeDateRange, now = new Date()): string | null {
  if (range === 'all') return null;
  if (range === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const days = range === '7d' ? 7 : 30;
  return new Date(now.getTime() - days * DAY_MS).toISOString();
}

export function toChangeApiQuery(filters: ChangeFilters, options: { cursor?: string | null; limit?: number; now?: Date } = {}) {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  if (options.cursor) params.set('cursor', options.cursor);
  if (filters.type.length) params.set('type', filters.type.join(','));
  if (filters.op.length) params.set('op', filters.op.join(','));
  if (filters.source.length) params.set('source', filters.source.join(','));
  if (filters.status.length) params.set('status', filters.status.join(','));
  const from = rangeToFrom(filters.range, options.now ?? new Date());
  if (from) params.set('from', from);
  const q = clipQuery(filters.q);
  if (q) params.set('q', q);
  return params.toString();
}

export function filtersToPageState(filters: ChangeFilters, now = new Date()): ChangePageState {
  const state: ChangePageState = {};
  if (filters.type.length) state.kind = clipPageState(filters.type.join(','));
  if (filters.op.length) state.operation = clipPageState(filters.op.join(','));
  if (filters.source.length) state.source = clipPageState(filters.source.join(','));
  if (filters.status.length) state.status = clipPageState(filters.status.join(','));
  const from = rangeToFrom(filters.range, now);
  if (from) state.dateFrom = from;
  const q = clipQuery(filters.q);
  if (q) state.query = clipPageState(q);
  return state;
}

function calendarKey(date: Date) {
  return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
}

export function changeDay(createdAt: string, now = new Date()): ChangeDay {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return 'earlier';
  const key = calendarKey(date);
  if (key === calendarKey(now)) return 'today';
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (key === calendarKey(yesterday)) return 'yesterday';
  return 'earlier';
}

/** Consecutive rows that share a day stay in one group, including across page boundaries. */
export function groupChangesByDay<T extends { createdAt: string }>(items: T[], now = new Date()): { day: ChangeDay; items: T[] }[] {
  const groups: { day: ChangeDay; items: T[] }[] = [];
  for (const item of items) {
    const day = changeDay(item.createdAt, now);
    const last = groups[groups.length - 1];
    if (last?.day === day) last.items.push(item);
    else groups.push({ day, items: [item] });
  }
  return groups;
}

/** Count of panel filters. Search text is a chip but not part of this number. */
export function filterCount(filters: ChangeFilters) {
  return filters.type.length + filters.op.length + filters.source.length + filters.status.length + (filters.range === 'all' ? 0 : 1);
}

export function hasActiveFilters(filters: ChangeFilters) {
  return filterCount(filters) > 0 || clipQuery(filters.q).length > 0;
}

export function changeChips(filters: ChangeFilters, connections: ChangeConnectionOption[] = []): ChangeChip[] {
  const chips: ChangeChip[] = [];
  for (const value of filters.type) {
    const known = isOneOf(CHANGE_ENTITY_TYPES, value);
    chips.push({ id: `type:${value}`, dimension: 'type', value, nameKey: 'changes.filters.object', valueKey: known ? `changes.entities.${value}` : null, valueText: known ? null : value });
  }
  for (const value of filters.op) chips.push({ id: `op:${value}`, dimension: 'op', value, nameKey: 'changes.filters.op', valueKey: `changes.opGroups.${value}`, valueText: null });
  for (const value of filters.source) {
    if (value === 'user' || value === 'assistant') {
      chips.push({ id: `source:${value}`, dimension: 'source', value, nameKey: 'changes.filters.source', valueKey: `changes.sources.${value}`, valueText: null });
      continue;
    }
    const connection = connections.find((item) => item.id === value.slice(2));
    chips.push({
      id: `source:${value}`,
      dimension: 'source',
      value,
      nameKey: 'changes.filters.source',
      valueKey: connection?.name ? null : 'changes.sources.deletedConnection',
      valueText: connection?.name ?? null,
    });
  }
  for (const value of filters.status) chips.push({ id: `status:${value}`, dimension: 'status', value, nameKey: 'changes.filters.status', valueKey: `changes.statuses.${value}`, valueText: null });
  if (filters.range !== 'all') chips.push({ id: `range:${filters.range}`, dimension: 'range', value: filters.range, nameKey: 'changes.filters.range', valueKey: `changes.ranges.${filters.range}`, valueText: null });
  const q = clipQuery(filters.q);
  if (q) chips.push({ id: 'q', dimension: 'q', value: q, nameKey: 'changes.searchPlaceholder', valueKey: null, valueText: q });
  return chips;
}

export function removeChangeChip(filters: ChangeFilters, id: string): ChangeFilters {
  if (id === 'q') return { ...filters, q: '' };
  const splitAt = id.indexOf(':');
  if (splitAt <= 0) return filters;
  const dimension = id.slice(0, splitAt);
  const value = id.slice(splitAt + 1);
  if (dimension === 'type') return { ...filters, type: filters.type.filter((item) => item !== value) };
  if (dimension === 'op') return { ...filters, op: filters.op.filter((item) => item !== value) };
  if (dimension === 'source') return { ...filters, source: filters.source.filter((item) => item !== value) };
  if (dimension === 'status') return { ...filters, status: filters.status.filter((item) => item !== value) };
  if (dimension === 'range') return { ...filters, range: 'all' };
  return filters;
}
