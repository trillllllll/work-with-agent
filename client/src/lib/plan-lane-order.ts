export const planLaneOrderStorageKey = 'dovun.plan.laneOrder.v1';
export const planLaneOrderLimit = 100;

export type PlanLaneOrders = Record<string, string[]>;
type LaneOrderEntry = { taskIds: string[]; updatedAt: number };
type LaneOrderStore = { version: 1; entries: Record<string, LaneOrderEntry> };
type LaneOrderStorage = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): LaneOrderStorage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}
function validTaskIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0))];
}
function readStore(storage: LaneOrderStorage | undefined): LaneOrderStore {
  const empty: LaneOrderStore = { version: 1, entries: {} };
  if (!storage) return empty;
  try {
    const raw: unknown = JSON.parse(storage.getItem(planLaneOrderStorageKey) ?? 'null');
    if (!raw || typeof raw !== 'object' || (raw as { version?: unknown }).version !== 1) return empty;
    const entries = (raw as { entries?: unknown }).entries;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return empty;
    const cleaned: Record<string, LaneOrderEntry> = {};
    for (const [key, value] of Object.entries(entries)) {
      if (!key || !value || typeof value !== 'object') continue;
      const taskIds = validTaskIds((value as { taskIds?: unknown }).taskIds);
      const updatedAt = (value as { updatedAt?: unknown }).updatedAt;
      if (taskIds.length && typeof updatedAt === 'number' && Number.isFinite(updatedAt)) cleaned[key] = { taskIds, updatedAt };
    }
    return { version: 1, entries: cleaned };
  } catch { return empty; }
}
function ordersOf(store: LaneOrderStore): PlanLaneOrders {
  return Object.fromEntries(Object.entries(store.entries).map(([key, entry]) => [key, [...entry.taskIds]]));
}
function trimStore(store: LaneOrderStore, limit: number) {
  const cap = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : planLaneOrderLimit;
  const entries = Object.entries(store.entries).sort((a, b) => b[1].updatedAt - a[1].updatedAt || a[0].localeCompare(b[0])).slice(0, cap);
  return { version: 1 as const, entries: Object.fromEntries(entries) };
}

export function loadPlanLaneOrders(storage: LaneOrderStorage | undefined = defaultStorage()): PlanLaneOrders {
  return ordersOf(trimStore(readStore(storage), planLaneOrderLimit));
}

/** Returns the new in-memory orders even when browser storage is unavailable or full. */
export function savePlanLaneOrder(groupKey: string, taskIds: readonly string[], storage: LaneOrderStorage | undefined = defaultStorage(), now = Date.now(), limit = planLaneOrderLimit, sessionOrders?: PlanLaneOrders): PlanLaneOrders {
  const store = sessionOrders ? { version: 1 as const, entries: Object.fromEntries(Object.entries(sessionOrders).map(([key, ids]) => [key, { taskIds: validTaskIds(ids), updatedAt: 0 }])) } : readStore(storage);
  const cleaned = validTaskIds([...taskIds]);
  if (groupKey && cleaned.length) store.entries[groupKey] = { taskIds: cleaned, updatedAt: Number.isFinite(now) ? now : Date.now() };
  const trimmed = trimStore(store, limit);
  try { storage?.setItem(planLaneOrderStorageKey, JSON.stringify(trimmed)); } catch { /* Keep the returned session-only order. */ }
  return ordersOf(trimmed);
}

export function movePlanLaneOrder(order: readonly string[], activeId: string, targetId: string, side: 'before' | 'after') {
  if (activeId === targetId || !order.includes(activeId) || !order.includes(targetId)) return [...order];
  const next = order.filter((id) => id !== activeId);
  const targetIndex = next.indexOf(targetId);
  next.splice(targetIndex + (side === 'after' ? 1 : 0), 0, activeId);
  return next;
}
