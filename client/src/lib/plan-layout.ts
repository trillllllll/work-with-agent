import type { TimedBlock } from './schedule.js';

export const laneMinPx = 56;
const footprintMinutes = 30;

/** How many lanes fit in `widthPx`, including the "+N" lane. Never below `floor`. */
export function laneCap(widthPx: number, minPx = laneMinPx, floor = 2) {
  const base = Number.isFinite(floor) ? floor : 2;
  if (!Number.isFinite(widthPx) || !Number.isFinite(minPx) || minPx <= 0 || widthPx <= 0) return base;
  return Math.max(base, Math.floor(widthPx / minPx));
}

export type LanePlacement = { block: TimedBlock; lane: number; laneCount: number; left: number; width: number };
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
/** Tasks that are not done take the leftmost free lane; completed tasks take the rightmost. Lane count stays at max concurrency. */
function assignLanes(group: TimedBlock[]): Slot[] {
  const laneEnds = Array.from({ length: maxConcurrency(group) }, () => -1);
  const slots: Slot[] = [];
  for (const block of group) {
    const free: number[] = [];
    for (let lane = 0; lane < laneEnds.length; lane += 1) if (laneEnds[lane] <= block.startMin) free.push(lane);
    const lane = free.length === 0 ? laneEnds.length : block.task.status === 'done' ? free[free.length - 1] : free[0];
    if (lane === laneEnds.length) laneEnds.push(-1);
    laneEnds[lane] = footprintEnd(block);
    slots.push({ block, lane });
  }
  return slots;
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
function collapse(slots: Slot[], maxLanes: number): { placed: LanePlacement[]; mores: LaneMore[] } {
  const laneCount = slots.reduce((max, slot) => Math.max(max, slot.lane + 1), 0);
  const overflow = laneCount > maxLanes;
  const denom = overflow ? maxLanes : laneCount;
  const placed: LanePlacement[] = [];
  const hidden: TimedBlock[] = [];
  for (const slot of slots) {
    if (!overflow || slot.lane < maxLanes - 1) placed.push({ block: slot.block, lane: slot.lane, laneCount: denom, left: slot.lane / denom, width: 1 / denom });
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
export function layoutLanes(blocks: TimedBlock[], maxLanes: number, opts?: { pinnedTaskId?: string }): { placed: LanePlacement[]; mores: LaneMore[] } {
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
    const slots = assignLanes(group);
    keepPinnedVisible(slots, cap, opts?.pinnedTaskId);
    const part = collapse(slots, cap);
    placed.push(...part.placed);
    mores.push(...part.mores);
  }
  placed.sort((a, b) => a.block.startMin - b.block.startMin || a.lane - b.lane || a.block.id.localeCompare(b.block.id));
  return { placed, mores };
}
