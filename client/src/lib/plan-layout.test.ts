import { describe, expect, it } from 'vitest';
import type { Task } from './api.js';
import { laneCap, laneGroupKey, layoutLanes, type LaneMore, type LanePlacement } from './plan-layout.js';
import { layoutTimed, type TimedBlock } from './schedule.js';

const minutes = (hour: number, minute = 0) => hour * 60 + minute;
const task = (id: string, start: string, end: string | null, status: Task['status'] = 'todo') => ({ id, status, scheduledStart: start, scheduledEnd: end, dueDate: start.slice(0, 10) }) as Task;
function timed(id: string, startMin: number, endMin: number, status: Task['status'] = 'todo', date = '2026-10-17', patch: Partial<Task> = {}): TimedBlock {
  return { id: `${id}:${date}`, startMin, endMin, point: startMin === endMin, startsHere: startMin > 0, endsHere: endMin < 1440, task: { id, status, ...patch } as Task };
}
const laneOf = (placed: LanePlacement[], id: string) => placed.find((item) => item.block.task.id === id)!;
const ids = (blocks: TimedBlock[]) => blocks.map((block) => block.task.id);

describe('lane cap', () => {
  it('returns the floor for empty widths and steps by the minimum lane width', () => {
    expect(laneCap(0)).toBe(2);
    expect(laneCap(-20)).toBe(2);
    expect(laneCap(Number.NaN)).toBe(2);
    expect(laneCap(55)).toBe(2);
    expect(laneCap(56)).toBe(2);
    expect(laneCap(112)).toBe(2);
    expect(laneCap(168)).toBe(3);
    expect(laneCap(224)).toBe(4);
  });
});

describe('layout lanes', () => {
  it('keeps the longer task left regardless of another task completion', () => {
    const { placed, mores } = layoutLanes([
      timed('qps', minutes(15), minutes(16), 'done'),
      timed('alipay', minutes(15), minutes(16, 30)),
      timed('bug', minutes(16), minutes(17)),
    ], 8);
    expect(mores).toEqual([]);
    expect(ids(placed.map((item) => item.block))).toEqual(['alipay', 'qps', 'bug']);
    expect(laneOf(placed, 'alipay')).toMatchObject({ lane: 0, laneCount: 2, left: 0, width: 1 / 2 });
    expect(laneOf(placed, 'qps')).toMatchObject({ lane: 1, laneCount: 2, left: 1 / 2, width: 1 / 2 });
    expect(laneOf(placed, 'bug')).toMatchObject({ lane: 1, laneCount: 2, left: 1 / 2, width: 1 / 2 });
  });

  it('reuses lanes across a chain and splits tasks that only touch', () => {
    const { placed, mores } = layoutLanes([
      timed('a', minutes(10), minutes(11)),
      timed('b', minutes(10, 30), minutes(12)),
      timed('c', minutes(11, 30), minutes(12, 30)),
      timed('d', minutes(12, 30), minutes(13)),
    ], 8);
    expect(mores).toEqual([]);
    expect(laneOf(placed, 'a').lane).toBe(0);
    expect(laneOf(placed, 'b').lane).toBe(1);
    expect(laneOf(placed, 'c').lane).toBe(0);
    expect([laneOf(placed, 'a').laneCount, laneOf(placed, 'b').laneCount, laneOf(placed, 'c').laneCount]).toEqual([2, 2, 2]);
    expect(laneOf(placed, 'd')).toMatchObject({ lane: 0, laneCount: 1, width: 1 });
    expect(layoutLanes([], 4)).toEqual({ placed: [], mores: [] });
  });

  it('puts the longer task on lane 0 when two tasks start together', () => {
    const { placed } = layoutLanes([
      timed('a', minutes(10), minutes(10, 30)),
      timed('b', minutes(10), minutes(12)),
    ], 8);
    expect(laneOf(placed, 'b').lane).toBe(0);
    expect(laneOf(placed, 'a').lane).toBe(1);
  });

  it('overlaps short tasks by footprint and lets a task starting at the footprint end share a lane', () => {
    const { placed } = layoutLanes([
      timed('early', minutes(10), minutes(10, 10)),
      timed('mid', minutes(10, 20), minutes(10, 40)),
      timed('late', minutes(10, 30), minutes(11)),
    ], 8);
    expect(laneOf(placed, 'early').lane).not.toBe(laneOf(placed, 'mid').lane);
    expect(laneOf(placed, 'early').lane).toBe(laneOf(placed, 'late').lane);
    expect(laneOf(placed, 'mid').lane).not.toBe(laneOf(placed, 'late').lane);
    expect(laneOf(placed, 'early').laneCount).toBe(2);
  });

  it('keeps lanes stable when completion status changes', () => {
    const rows = (status: Task['status']) => [
      timed('open', minutes(10), minutes(11)),
      timed('shut', minutes(10), minutes(12), status),
    ];
    const before = layoutLanes(rows('todo'), 8);
    const after = layoutLanes(rows('done'), 8);
    expect(after.placed.map((item) => ({ id: item.block.task.id, lane: item.lane, width: item.width }))).toEqual(before.placed.map((item) => ({ id: item.block.task.id, lane: item.lane, width: item.width })));
    expect(laneOf(after.placed, 'shut')).toMatchObject({ lane: 0, width: 1 / 2 });
    expect(laneOf(after.placed, 'open')).toMatchObject({ lane: 1, width: 1 / 2 });
    const only = layoutLanes([timed('open', minutes(10), minutes(11))], 8);
    expect(only.placed[0]).toMatchObject({ lane: 0, laneCount: 1, width: 1 });
  });

  it('keeps parents, children and siblings adjacent before unrelated tasks', () => {
    const rows = [
      timed('other', minutes(10), minutes(11)),
      timed('child-b', minutes(10), minutes(11), 'done', undefined, { parentId: 'parent', sortOrder: 1 }),
      timed('grandchild', minutes(10), minutes(11), 'todo', undefined, { parentId: 'child-a', sortOrder: 0 }),
      timed('parent', minutes(10), minutes(12), 'done'),
      timed('child-a', minutes(10), minutes(11), 'todo', undefined, { parentId: 'parent', sortOrder: 0 }),
    ];
    const { placed, mores } = layoutLanes(rows, 8);
    expect(mores).toEqual([]);
    expect(ids(placed.map((item) => item.block))).toEqual(['parent', 'child-a', 'grandchild', 'child-b', 'other']);
    expect(laneOf(placed, 'parent').laneCount).toBe(5);
  });

  it('keeps visible siblings together when their parent is absent', () => {
    const { placed } = layoutLanes([
      timed('z-other', minutes(10), minutes(11)),
      timed('b-child', minutes(10), minutes(11), 'todo', undefined, { parentId: 'missing', sortOrder: 1 }),
      timed('a-child', minutes(10), minutes(11), 'todo', undefined, { parentId: 'missing', sortOrder: 0 }),
    ], 8);
    expect(ids(placed.map((item) => item.block))).toEqual(['a-child', 'b-child', 'z-other']);
  });

  it('applies a valid manual order only to its exact overlap group', () => {
    const rows = [
      timed('a', minutes(10), minutes(11)),
      timed('b', minutes(10), minutes(11)),
      timed('c', minutes(10), minutes(11)),
    ];
    const group = [...rows].sort((a, b) => a.startMin - b.startMin || a.id.localeCompare(b.id));
    const key = laneGroupKey(group);
    expect(key).toBe('2026-10-17:600:a,b,c');
    const manual = layoutLanes(rows, 8, { manualOrders: { [key]: ['c', 'a', 'b'] } });
    expect(ids(manual.placed.map((item) => item.block))).toEqual(['c', 'a', 'b']);
    const changedGroup = layoutLanes(rows.slice(0, 2), 8, { manualOrders: { [key]: ['c', 'a', 'b'] } });
    expect(ids(changedGroup.placed.map((item) => item.block))).toEqual(['a', 'b']);
  });

  it('does not open an extra lane for completed tasks', () => {
    const { placed } = layoutLanes([
      timed('a', minutes(9), minutes(10)),
      timed('c', minutes(9, 30), minutes(11)),
      timed('b', minutes(10), minutes(11), 'done'),
    ], 8);
    expect(laneOf(placed, 'a').lane).toBe(0);
    expect(laneOf(placed, 'c').lane).toBe(1);
    expect(laneOf(placed, 'b')).toMatchObject({ lane: 0, laneCount: 2, width: 1 / 2 });
  });

  it('reuses two lanes when a manual order reverses a chronological chain', () => {
    const rows = [
      timed('a', minutes(10), minutes(11)),
      timed('b', minutes(10, 30), minutes(11, 30)),
      timed('c', minutes(11), minutes(12)),
    ];
    const result = layoutLanes(rows, 2, { manualOrders: { [laneGroupKey(rows)]: ['c', 'b', 'a'] } });
    expect(result.mores).toEqual([]);
    expect(result.placed).toHaveLength(3);
    expect(laneOf(result.placed, 'c')).toMatchObject({ lane: 0, laneCount: 2 });
    expect(laneOf(result.placed, 'a').lane).toBe(0);
    expect(laneOf(result.placed, 'b').lane).toBe(1);
    expect(sameLaneOverlap(result.placed)).toBe(false);
  });

  it('reuses lanes when family order puts a later parent before an earlier child', () => {
    const rows = [
      timed('child', minutes(10), minutes(11), 'todo', undefined, { parentId: 'parent' }),
      timed('other', minutes(10, 30), minutes(11, 30)),
      timed('parent', minutes(11), minutes(12)),
    ];
    const result = layoutLanes(rows, 2);
    expect(result.mores).toEqual([]);
    expect(result.placed).toHaveLength(3);
    expect(laneOf(result.placed, 'parent')).toMatchObject({ lane: 0, laneCount: 2 });
    expect(laneOf(result.placed, 'child').lane).toBe(0);
    expect(sameLaneOverlap(result.placed)).toBe(false);
  });

  it('does not grow a block into a free neighboring lane', () => {
    const { placed } = layoutLanes([
      timed('a', minutes(9), minutes(10)),
      timed('b', minutes(9, 30), minutes(11)),
    ], 8);
    expect(laneOf(placed, 'a')).toMatchObject({ lane: 0, laneCount: 2, left: 0, width: 1 / 2 });
    expect(laneOf(placed, 'b')).toMatchObject({ lane: 1, laneCount: 2, left: 1 / 2, width: 1 / 2 });
  });

  it('folds lanes past the cap into a +N chip and splits that chip across footprint gaps', () => {
    const packed = layoutLanes([
      timed('a', minutes(10), minutes(11)),
      timed('b', minutes(10), minutes(11)),
      timed('c', minutes(10), minutes(11)),
    ], 2);
    expect(packed.placed).toHaveLength(1);
    expect(laneOf(packed.placed, 'a')).toMatchObject({ lane: 0, laneCount: 2, left: 0, width: 1 / 2 });
    expect(packed.mores).toHaveLength(1);
    expect(packed.mores[0]).toMatchObject({ id: 'b:more:600', startMin: 600, endMin: 660, left: 1 / 2, width: 1 / 2 });
    expect(ids(packed.mores[0].blocks)).toEqual(['b', 'c']);

    const gapped = layoutLanes([
      timed('long', minutes(9), minutes(12)),
      timed('a', minutes(9), minutes(9, 30)),
      timed('b', minutes(9), minutes(9, 30)),
      timed('c', minutes(11), minutes(11, 30)),
    ], 2);
    expect(ids(gapped.placed.map((item) => item.block))).toEqual(['long']);
    expect(gapped.mores.map((more) => ({ id: more.id, startMin: more.startMin, endMin: more.endMin, blocks: ids(more.blocks) }))).toEqual([
      { id: 'a:more:540', startMin: 540, endMin: 570, blocks: ['a', 'b'] },
      { id: 'c:more:660', startMin: 660, endMin: 690, blocks: ['c'] },
    ]);

    const shorts = layoutLanes([
      timed('anchor', minutes(10), minutes(11)),
      timed('s1', minutes(10), minutes(10, 10)),
      timed('s2', minutes(10, 20), minutes(10, 40)),
    ], 2);
    expect(shorts.mores).toHaveLength(1);
    expect(shorts.mores[0]).toMatchObject({ id: 's1:more:600', startMin: 600, endMin: 650 });
    expect(ids(shorts.mores[0].blocks)).toEqual(['s1', 's2']);
  });

  it('swaps a pinned task out of +N and changes the +N count', () => {
    const rows = [
      timed('a', minutes(10), minutes(11)),
      timed('b', minutes(10), minutes(11)),
      timed('c', minutes(10), minutes(11)),
    ];
    const folded = layoutLanes(rows, 2);
    expect(ids(folded.mores[0].blocks)).toEqual(['b', 'c']);
    const pinned = layoutLanes(rows, 2, { pinnedTaskId: 'c' });
    expect(laneOf(pinned.placed, 'c')).toMatchObject({ lane: 0, laneCount: 2 });
    expect(ids(pinned.mores[0].blocks)).toEqual(['a', 'b']);
    expect(pinned.mores[0].blocks.some((block) => block.task.id === 'c')).toBe(false);

    const chain = [
      timed('a', minutes(9), minutes(12)),
      timed('b', minutes(9), minutes(10)),
      timed('d', minutes(9), minutes(10)),
      timed('c', minutes(11), minutes(12)),
    ];
    expect(layoutLanes(chain, 2).mores.map((more) => more.blocks.length)).toEqual([2, 1]);
    const swapped = layoutLanes(chain, 2, { pinnedTaskId: 'c' });
    expect(ids(swapped.placed.map((item) => item.block))).toEqual(['c']);
    expect(swapped.mores.map((more) => more.blocks.length)).toEqual([3]);
    expect(ids(swapped.mores[0].blocks)).toEqual(['a', 'b', 'd']);

    const visible = layoutLanes([
      timed('a', minutes(10), minutes(11)),
      timed('b', minutes(10), minutes(12), 'done'),
    ], 2, { pinnedTaskId: 'b' });
    expect(laneOf(visible.placed, 'b').lane).toBe(0);
    expect(visible.mores).toEqual([]);
  });

  it('gives an overlapping point its own lane', () => {
    const point = task('point', '2026-10-11T23:00', null);
    const range = task('range', '2026-10-11T23:00', '2026-10-12T01:00');
    const { placed } = layoutLanes(layoutTimed([point, range], '2026-10-11'), 8);
    expect(placed).toHaveLength(2);
    expect(new Set(placed.map((item) => item.lane)).size).toBe(2);
    expect(placed.every((item) => item.laneCount === 2)).toBe(true);
    expect(laneOf(placed, 'point').block).toMatchObject({ startMin: 1380, endMin: 1380, point: true });
  });

  it('places the post-midnight slice at minute 0 and keeps the following point in its own group', () => {
    const rows = [
      task('overnight', '2026-10-17T23:00', '2026-10-18T01:00'),
      task('point', '2026-10-18T00:30', null),
      task('later', '2026-10-18T01:00', null),
    ];
    const { placed, mores } = layoutLanes(layoutTimed(rows, '2026-10-18'), 8);
    expect(mores).toEqual([]);
    expect(laneOf(placed, 'overnight').block).toMatchObject({ startMin: 0, endMin: 60, startsHere: false, endsHere: true });
    expect(laneOf(placed, 'overnight').lane).toBe(0);
    expect(laneOf(placed, 'point')).toMatchObject({ lane: 1, laneCount: 2 });
    expect(laneOf(placed, 'point').block.point).toBe(true);
    expect(laneOf(placed, 'later')).toMatchObject({ lane: 0, laneCount: 1, width: 1 });
    expect(laneOf(placed, 'later').block.startMin).toBe(60);
  });

  it('keeps lane count within max concurrency and never overlaps a lane', () => {
    const rand = mulberry32(20261020);
    const spans = [0, 10, 20, 30, 45, 60, 90, 120];
    let sawOverlap = false;
    for (let trial = 0; trial < 40; trial += 1) {
      const count = 1 + Math.floor(rand() * 10);
      const blocks = Array.from({ length: count }, (_, index) => {
        const startMin = Math.floor(rand() * 46) * 30;
        const endMin = Math.min(1440, startMin + spans[Math.floor(rand() * spans.length)]);
        return timed(String.fromCharCode(97 + index), startMin, endMin, rand() < 0.25 ? 'done' : 'todo');
      });
      const concurrent = maxConcurrent(blocks);
      if (concurrent > 1) sawOverlap = true;
      for (const maxLanes of [2, 8]) {
        const pinnedTaskId = blocks[Math.floor(rand() * blocks.length)].task.id;
        const manualOrders = Object.fromEntries(layoutLanes(blocks, 8).placed.map((item) => [item.groupKey, [...item.groupTaskIds].reverse()]));
        for (const opts of [undefined, { pinnedTaskId }, { manualOrders }, { pinnedTaskId, manualOrders }] as const) {
          const result = layoutLanes(blocks, maxLanes, opts);
          expect(coveredIds(result)).toEqual(blocks.map((block) => block.id).sort());
          expect(sortedPlaced(result.placed)).toBe(true);
          for (const item of result.placed) {
            expect(item.laneCount).toBeLessThanOrEqual(concurrent);
            expect(item.laneCount).toBeGreaterThan(0);
            expect(item.left).toBeCloseTo(item.lane / item.laneCount);
            expect(item.width).toBeCloseTo(1 / item.laneCount);
          }
          if (result.mores.length === 0 && blocks.length > 0) expect(Math.max(...result.placed.map((item) => item.laneCount))).toBe(concurrent);
          expect(sameLaneOverlap(result.placed)).toBe(false);
          if (opts && 'pinnedTaskId' in opts) expect(result.placed.some((item) => item.block.task.id === pinnedTaskId)).toBe(true);
        }
      }
    }
    expect(sawOverlap).toBe(true);
  });
});

function coveredIds(result: { placed: LanePlacement[]; mores: LaneMore[] }) {
  return [...result.placed.map((item) => item.block.id), ...result.mores.flatMap((more) => more.blocks.map((block) => block.id))].sort();
}
function sortedPlaced(placed: LanePlacement[]) {
  for (let index = 1; index < placed.length; index += 1) {
    const previous = placed[index - 1];
    const current = placed[index];
    if (previous.block.startMin > current.block.startMin) return false;
    if (previous.block.startMin === current.block.startMin && previous.lane > current.lane) return false;
  }
  return true;
}
function sameLaneOverlap(placed: LanePlacement[]) {
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      if (placed[i].lane !== placed[j].lane) continue;
      const a = placed[i].block;
      const b = placed[j].block;
      const aEnd = Math.max(a.endMin, a.startMin + 30);
      const bEnd = Math.max(b.endMin, b.startMin + 30);
      if (a.startMin < bEnd && b.startMin < aEnd) return true;
    }
  }
  return false;
}
function maxConcurrent(blocks: TimedBlock[]) {
  const events = blocks.flatMap((block) => {
    const end = Math.max(block.endMin, block.startMin + 30);
    return [{ t: block.startMin, d: 1 }, { t: end, d: -1 }];
  });
  events.sort((a, b) => a.t - b.t || a.d - b.d);
  let current = 0;
  let max = 0;
  for (const event of events) {
    current += event.d;
    if (current > max) max = current;
  }
  return max;
}
function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
