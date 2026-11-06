import { validateMermaid } from '../shared/mermaid-policy.js';
export { validateMermaid } from '../shared/mermaid-policy.js';
import { htmlFragments } from '../shared/streaming-markup.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { sanitizeSvg } from './svg-sanitize.js';
import { HTML_HEIGHT_MAX, HTML_HEIGHT_MIN, HTML_SOURCE_LIMIT, validateHtmlSource, type HtmlBlockPolicy } from './html-block.js';

const label = z.string().max(300);
const number = z.number().finite();
const provenance = z.union([
  z.object({ kind: z.enum(['simulated', 'unverified']), label }).strict(),
  z.object({ kind: z.literal('tool'), label, messageId: label.min(1), toolCallId: label.min(1), dataPath: z.array(z.string().min(1).max(100)).max(8), categoryField: label.optional(), valueFields: z.array(label.min(1)).min(1).max(20) }).strict(),
]);
const series = z.object({ name: label, values: z.array(number.nullable()).max(5000) }).strict();
export const chartSpecSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('line'), title: label, unit: label.optional(), categories: z.array(label).max(5000), series: z.array(series).min(1).max(10), provenance }).strict(),
  z.object({ kind: z.literal('bar'), title: label, unit: label.optional(), categories: z.array(label).max(5000), series: z.array(series).min(1).max(10), provenance }).strict(),
  z.object({ kind: z.literal('pie'), title: label, unit: label.optional(), values: z.array(z.object({ name: label, value: number.nonnegative() }).strict()).min(1).max(5000), provenance }).strict(),
  z.object({ kind: z.literal('scatter'), title: label, unit: label.optional(), series: z.array(z.object({ name: label, values: z.array(z.tuple([number, number])).max(5000) }).strict()).min(1).max(10), provenance }).strict(),
]);
const common = { title: label.optional(), alt: z.string().max(2000).optional() };
export const replyBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), studySupport: z.enum(['hint', 'solution']).optional(), markdown: z.string().max(65536), ...common }).strict(),
  z.object({ type: z.literal('mermaid'), source: z.string().min(1).max(16384), ...common }).strict(),
  z.object({ type: z.literal('svg'), source: z.string().min(1).max(65536), ...common }).strict(),
  z.object({ type: z.literal('html'), renderMode: z.literal('fragments').optional(), source: z.string().min(1).max(HTML_SOURCE_LIMIT), title: label.optional(), alt: z.string().min(1).max(2000), height: z.number().int().min(HTML_HEIGHT_MIN).max(HTML_HEIGHT_MAX).optional() }).strict(),
  z.object({ type: z.literal('chart'), spec: chartSpecSchema, ...common }).strict(),
  z.object({ type: z.literal('image_search'), searchId: label.min(1), resultIds: z.array(label.min(1)).min(1).max(8), layout: z.enum(['single', 'grid', 'carousel']).optional(), ...common }).strict(),
]);
export const presentReplySchema = z.object({ blocks: z.array(replyBlockSchema).min(1).max(32) }).strict();
export const presentReplyParameters = zodToJsonSchema(presentReplySchema, { $refStrategy: 'none' }) as Record<string, unknown>;
export type ChartSpec = z.infer<typeof chartSpecSchema>;
export type ReplyBlock = z.infer<typeof replyBlockSchema>;
export type ImageResult = { id: string; url: string; thumbnail: string; title: string; sourceUrl: string; searchedAt: string };
export type ContentBlock = {
  id: string; index: number; type: ReplyBlock['type'] | 'pending'; status: 'pending' | 'ready' | 'error';
  title?: string; alt?: string; error?: string; markdown?: string; source?: string; spec?: ChartSpec;
  searchId?: string; items?: ImageResult[]; layout?: 'single' | 'grid' | 'carousel'; height?: number;
  studySupport?: 'hint' | 'solution';
  renderMode?: 'fragments'; previewSpec?: ChartSpec; previewRevision?: number;
};
export type MessageBlocks = { schemaVersion: 1; blocks: ContentBlock[] };
export type BlockEvent = { type: 'block_start' | 'block_delta' | 'block_source_delta' | 'block_chart_preview' | 'block_commit' | 'block_error'; blockId: string; previewAvailable?: boolean; renderMode?: 'fragments'; previewSpec?: ChartSpec; revision?: number; index?: number; blockType?: ContentBlock['type']; block?: ContentBlock; offset?: number; delta?: string; studySupport?: 'hint' | 'solution'; code?: string; message?: string };

export async function validateReplyBlock(raw: unknown, images: (searchId: string, resultIds: string[]) => Promise<ImageResult[]>, chartSource?: (spec: ChartSpec) => Promise<void>, htmlPolicy?: HtmlBlockPolicy): Promise<Omit<ContentBlock, 'id' | 'index' | 'status'>> {
  const block = replyBlockSchema.parse(raw);
  if (block.type === 'mermaid') validateMermaid(block.source);
  if (block.type === 'svg') return { ...block, source: sanitizeSvg(block.source) };
  if (block.type === 'html') { if (!htmlPolicy) throw new Error('html 块当前不可用'); validateHtmlSource(block.source, htmlPolicy); if (block.renderMode === 'fragments') htmlFragments(block.source, true); }
  if (block.type === 'chart') {
    const spec = block.spec;
    if (spec.provenance.kind === 'tool') { if (!chartSource) throw new Error('无法核验图表来源'); await chartSource(spec); }
    if ((spec.kind === 'line' || spec.kind === 'bar') && spec.series.some((row) => row.values.length !== spec.categories.length)) throw new Error('图表分类和数值数量不一致');
    const count = spec.kind === 'pie' ? spec.values.length : spec.series.reduce((sum, row) => sum + row.values.length, 0);
    if (count > 5000) throw new Error('图表数据超过 5000 点');
  }
  if (block.type === 'image_search') {
    const { resultIds, ...rest } = block;
    return { ...rest, items: await images(block.searchId, resultIds) };
  }
  return block;
}
export function parseMessageBlocks(raw: string | null | undefined): ContentBlock[] {
  try { const data = JSON.parse(raw || 'null') as MessageBlocks; return data?.schemaVersion === 1 && Array.isArray(data.blocks) ? data.blocks : []; } catch { return []; }
}
export { projectBlocks } from './content-projection.js';
