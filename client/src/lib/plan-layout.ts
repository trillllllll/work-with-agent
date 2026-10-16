import type { TimedBlock } from './schedule.js';

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
