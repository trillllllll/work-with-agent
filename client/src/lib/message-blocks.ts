import type { ContentBlock, MessageBlocks } from '../../../server/src/agent/content-blocks.js';
export type { ContentBlock, MessageBlocks };
export function readMessageBlocks(raw: string | null | undefined): ContentBlock[] {
  try {
    const data = JSON.parse(raw || 'null') as MessageBlocks;
    if (data?.schemaVersion !== 1 || !Array.isArray(data.blocks) || data.blocks.length > 33) return [];
    return data.blocks.filter((block) => typeof block.id === 'string' && Number.isInteger(block.index) && block.index >= 0).sort((a, b) => a.index - b.index);
  } catch { return []; }
}
