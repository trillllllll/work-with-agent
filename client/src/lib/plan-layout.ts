import type { TimedBlock } from './schedule.js';

/** How many stack rows fit. At least 1 and at most 3. A separate “还有 N 个” line is reserved only when it fits; otherwise the caller puts it on the last row. */
export function stackFit(spanPx: number, rowPx: number, morePx: number, total: number, max = 3) {
  const cap = Math.min(max, Math.max(0, total));
  if (cap === 0) return { shown: 0, moreLine: false };
  for (let shown = cap; shown >= 1; shown -= 1) {
    const hidden = total - shown;
    if (hidden === 0 && shown * rowPx <= spanPx + 0.5) return { shown, moreLine: false };
    if (hidden > 0 && shown * rowPx + morePx <= spanPx + 0.5) return { shown, moreLine: true };
  }
  return { shown: 1, moreLine: false };
}

/** Keep the same visible footprints as layoutTimed, including point labels. */
export function groupTimedBlocks(blocks: TimedBlock[]) {
  const groups: TimedBlock[][] = [];
  let end = -1;
  for (const block of blocks) {
    if (block.startMin >= end) { groups.push([]); end = -1; }
    groups[groups.length - 1].push(block);
    end = Math.max(end, block.endMin, block.startMin + 30);
  }
  return groups;
}
