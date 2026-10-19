import type { ContentBlock } from './content-blocks.js';

/** Readable projection for search, old clients, compaction, saved threads and memory. */
export function projectBlocks(blocks: ContentBlock[]) {
  return blocks.map((block) => {
    const text = block.type === 'text' ? block.markdown || '' : block.type === 'mermaid' || block.type === 'svg' ? `${block.title || block.type}\n\`\`\`${block.type}\n${block.source || block.alt || ''}\n\`\`\`` : block.type === 'chart' && block.spec ? `${block.spec.title}（${block.spec.provenance.label}）\n\`\`\`json\n${JSON.stringify(block.spec)}\n\`\`\`` : block.type === 'image_search' ? (block.items ?? []).map((item) => `图片：${item.title}\n来源：${item.sourceUrl}\n图片地址：${item.url}\n检索时间：${item.searchedAt}`).join('\n') : block.alt || '';
    return `${text}${block.status === 'error' ? `\n（未完成：${block.error || '内容未完成'}）` : ''}`;
  }).filter(Boolean).join('\n\n');
}
