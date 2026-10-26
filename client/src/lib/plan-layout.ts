import type { TimedBlock } from './schedule.js';

export const laneMinPx = 56;
const footprintMinutes = 30;

/** How many lanes fit in `widthPx`, including the "+N" lane. Never below `floor`. */
export function laneCap(widthPx: number, minPx = laneMinPx, floor = 2) {
  const base = Number.isFinite(floor) ? floor : 2;
  if (!Number.isFinite(widthPx) || !Number.isFinite(minPx) || minPx <= 0 || widthPx <= 0) return base;
  return Math.max(base, Math.floor(widthPx / minPx));
}

export type LanePlacement = { block: TimedBlock; lane: number; laneCount: number; left: number; width: number; groupKey: string; groupTaskIds: string[] };
/** One "+N" chip. `endMin` is the footprint-union end (at least 30 minutes), covering the space the hidden tasks occupy. */
export type LaneMore = { id: string; startMin: number; endMin: number; left: number; width: number; blocks: TimedBlock[] };

type Slot = { block: TimedBlock; lane: number };

function footprintEnd(block: TimedBlock) {
  return Math.max(block.endMin, block.startMin + footprintMinutes);
}
function overlaps(a: TimedBlock, b: TimedBlock) {
  return a.startMin < footprintEnd(b) && b.startMin < footprintEnd(a);
}
/** layoutTimed ids look like `${taskId}:${yyyy-mm-dd}`. More ids drop that day suffix. */
function dayAgnosticBlockId(block: TimedBlock) {
  return block.id.replace(/:\d{4}-\d{2}-\d{2}$/, '');
}
function byStart(a: TimedBlock, b: TimedBlock) {
  return a.startMin - b.startMin || (b.endMin - b.startMin) - (a.endMin - a.startMin) || a.id.localeCompare(b.id);
}
function bySibling(a: TimedBlock, b: TimedBlock) {
  const aOrder = a.task.sortOrder ?? Number.POSITIVE_INFINITY;
  const bOrder = b.task.sortOrder ?? Number.POSITIVE_INFINITY;
  return aOrder - bOrder || byStart(a, b);
}
/** Group visible branches under their nearest visible root or missing parent. */
function familyKey(block: TimedBlock, visible: Map<string, TimedBlock>) {
  let current = block;
  const seen = new Set<string>();
  while (!seen.has(current.task.id)) {
    seen.add(current.task.id);
    const parentId = current.task.parentId;
    if (!parentId) return `task:${current.task.id}`;
    const parent = visible.get(parentId);
    if (!parent) return `parent:${parentId}`;
    current = parent;
  }
  return `task:${block.task.id}`;
}
/** Keep parents next to children without changing the chronological overlap groups. */
function byFamily(group: TimedBlock[]) {
  const visible = new Map(group.map((block) => [block.task.id, block]));
  const families = new Map<string, TimedBlock[]>();
  for (const block of group) {
    const key = familyKey(block, visible);
    const family = families.get(key) ?? [];
    family.push(block);
    families.set(key, family);
  }
  const orderedFamilies = [...families.entries()].map(([key, blocks]) => {
    const children = new Map<string | null, TimedBlock[]>();
    const roots: TimedBlock[] = [];
    for (const block of blocks) {
      const parentId = block.task.parentId;
      if (parentId && visible.has(parentId)) {
        const siblings = children.get(parentId) ?? [];
        siblings.push(block);
        children.set(parentId, siblings);
      } else roots.push(block);
    }
    const flattened: TimedBlock[] = [];
    const visit = (block: TimedBlock) => {
      flattened.push(block);
      for (const child of (children.get(block.task.id) ?? []).sort(bySibling)) visit(child);
    };
    for (const root of roots.sort(bySibling)) visit(root);
    return { key, blocks, flattened };
  });
  orderedFamilies.sort((a, b) => {
    const aFirst = [...a.blocks].sort(byStart)[0];
    const bFirst = [...b.blocks].sort(byStart)[0];
    return byStart(aFirst, bFirst) || a.key.localeCompare(b.key);
  });
  return orderedFamilies.flatMap((family) => family.flattened);
}
/** Date, group start and exact membership scope a saved order to one overlap group. */
export function laneGroupKey(group: TimedBlock[]) {
  if (!group.length) return '';
  const day = /:(\d{4}-\d{2}-\d{2})$/.exec(group[0].id)?.[1] ?? '';
  const ids = group.map((block) => block.task.id).sort();
  return `${day}:${group[0].startMin}:${ids.join(',')}`;
}
function applyManualOrder(group: TimedBlock[], order: readonly string[] | undefined) {
  const fallback = byFamily(group);
  if (!order || order.length !== group.length) return fallback;
  const visible = new Map(fallback.map((block) => [block.task.id, block]));
  if (new Set(order).size !== order.length || order.some((id) => !visible.has(id))) return fallback;
  return order.map((id) => visible.get(id)!);
}
function maxConcurrency(group: TimedBlock[]) {
  const events: { t: number; d: number }[] = [];
  for (const block of group) events.push({ t: block.startMin, d: 1 }, { t: footprintEnd(block), d: -1 });
  events.sort((a, b) => a.t - b.t || a.d - b.d);
  let current = 0;
  let max = 0;
  for (const event of events) {
    current += event.d;
    if (current > max) max = current;
  }
  return max;
}
/** Allocate chronologically to preserve max concurrency, then order whole lanes by display preference. */
function assignLanes(group: TimedBlock[]): Slot[] {
  const preference = new Map(group.map((block, index) => [block.task.id, index]));
  const chronological = [...group].sort((a, b) => a.startMin - b.startMin || preference.get(a.task.id)! - preference.get(b.task.id)!);
  const laneEnds = Array.from({ length: maxConcurrency(group) }, () => -1);
  const slots: Slot[] = [];
  for (const block of chronological) {
    const lane = laneEnds.findIndex((end) => end <= block.startMin);
    laneEnds[lane] = footprintEnd(block);
    slots.push({ block, lane });
  }
  // A later task may rank first after a horizontal move. Move its entire lane
  // rather than treating earlier tasks as if they followed it in time.
  const lanePriority = laneEnds.map(() => Number.POSITIVE_INFINITY);
  for (const slot of slots) lanePriority[slot.lane] = Math.min(lanePriority[slot.lane], preference.get(slot.block.task.id)!);
  const laneOrder = lanePriority.map((_, lane) => lane).sort((a, b) => lanePriority[a] - lanePriority[b]);
  const laneIndex = new Map(laneOrder.map((lane, index) => [lane, index]));
  return slots.map((slot) => ({ ...slot, lane: laneIndex.get(slot.lane)! })).sort((a, b) => preference.get(a.block.task.id)! - preference.get(b.block.task.id)!);
}
/** Keep the dragged block mounted: if it would fall into "+N", swap it with the overlapping block on the last visible lane. */
function keepPinnedVisible(slots: Slot[], maxLanes: number, pinnedTaskId: string | undefined) {
  if (!pinnedTaskId || maxLanes < 2) return;
  const laneCount = slots.reduce((max, slot) => Math.max(max, slot.lane + 1), 0);
  if (laneCount <= maxLanes) return;
  const pinned = slots.find((slot) => slot.block.task.id === pinnedTaskId);
  if (!pinned || pinned.lane < maxLanes - 1) return;
  const visibleLane = maxLanes - 2;
  const from = pinned.lane;
  const displaced = slots.filter((slot) => slot.lane === visibleLane && overlaps(slot.block, pinned.block));
  pinned.lane = visibleLane;
  for (const slot of displaced) slot.lane = from;
}
/** Hidden tasks on the last lane and beyond become "+N" chips, split where their footprints leave a gap. */
function collapse(slots: Slot[], maxLanes: number, groupKey: string): { placed: LanePlacement[]; mores: LaneMore[] } {
  const laneCount = slots.reduce((max, slot) => Math.max(max, slot.lane + 1), 0);
  const overflow = laneCount > maxLanes;
  const denom = overflow ? maxLanes : laneCount;
  const placed: LanePlacement[] = [];
  const hidden: TimedBlock[] = [];
  const groupTaskIds = slots.map((slot) => slot.block.task.id);
  for (const slot of slots) {
    if (!overflow || slot.lane < maxLanes - 1) placed.push({ block: slot.block, lane: slot.lane, laneCount: denom, left: slot.lane / denom, width: 1 / denom, groupKey, groupTaskIds: [...groupTaskIds] });
    else hidden.push(slot.block);
  }
  const mores: LaneMore[] = [];
  hidden.sort((a, b) => a.startMin - b.startMin || a.id.localeCompare(b.id));
  for (const block of hidden) {
    const end = footprintEnd(block);
    const current = mores[mores.length - 1];
    if (!current || block.startMin >= current.endMin) {
      mores.push({ id: `${dayAgnosticBlockId(block)}:more:${block.startMin}`, startMin: block.startMin, endMin: end, left: (maxLanes - 1) / denom, width: 1 / denom, blocks: [block] });
      continue;
    }
    current.endMin = Math.max(current.endMin, end);
    current.blocks.push(block);
  }
  return { placed, mores };
}
export function layoutLanes(blocks: TimedBlock[], maxLanes: number, opts?: { pinnedTaskId?: string; manualOrders?: Readonly<Record<string, readonly string[]>> }): { placed: LanePlacement[]; mores: LaneMore[] } {
  const cap = Number.isFinite(maxLanes) ? Math.max(1, Math.floor(maxLanes)) : Number.POSITIVE_INFINITY;
  const sorted = [...blocks].sort(byStart);
  const groups: TimedBlock[][] = [];
  let groupEnd = -1;
  for (const block of sorted) {
    if (block.startMin >= groupEnd) { groups.push([]); groupEnd = -1; }
    groups[groups.length - 1].push(block);
    groupEnd = Math.max(groupEnd, footprintEnd(block));
  }
  const placed: LanePlacement[] = [];
  const mores: LaneMore[] = [];
  for (const group of groups) {
    const groupKey = laneGroupKey(group);
    const ordered = applyManualOrder(group, opts?.manualOrders?.[groupKey]);
    const slots = assignLanes(ordered);
    keepPinnedVisible(slots, cap, opts?.pinnedTaskId);
    const part = collapse(slots, cap, groupKey);
    placed.push(...part.placed);
    mores.push(...part.mores);
  }
  placed.sort((a, b) => a.block.startMin - b.block.startMin || a.lane - b.lane || a.block.id.localeCompare(b.block.id));
  return { placed, mores };
}
