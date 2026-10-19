import { prisma } from '../infrastructure/prisma.js';
import type { ChartSpec } from './content-blocks.js';
/** Bind each plotted value to an actual, successful tool result in this conversation. */
export async function verifyChartSource(conversationId: string, spec: ChartSpec) {
  const source = spec.provenance;
  if (source.kind !== 'tool') return;
  const message = await prisma.message.findFirst({ where: { id: source.messageId, conversationId, role: 'tool', toolCallId: source.toolCallId }, select: { content: true } });
  if (!message) throw new Error('图表引用不属于当前会话');
  const result = JSON.parse(message.content) as { success?: boolean; data?: unknown };
  if (!result.success) throw new Error('图表不能引用失败的工具结果');
  let data: unknown = result.data;
  for (const key of source.dataPath) {
    if (!data || typeof data !== 'object' || !Object.prototype.hasOwnProperty.call(data, key)) throw new Error('图表来源路径不存在');
    data = (data as Record<string, unknown>)[key];
  }
  if (!Array.isArray(data) || !data.length || data.length > 5000 || data.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('图表来源需要一组数据行');
  const rows = data as Record<string, unknown>[];
  const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  const categories = source.categoryField ? rows.map((row) => row[source.categoryField!]) : [];
  if (spec.kind === 'line' || spec.kind === 'bar') {
    if (!equal(categories, spec.categories) || spec.series.length !== source.valueFields.length || spec.series.some((series, index) => !equal(series.values, rows.map((row) => row[source.valueFields[index]])))) throw new Error('图表与工具来源的分类或数值不一致');
  } else if (spec.kind === 'pie') {
    if (source.valueFields.length !== 1 || !equal(spec.values, rows.map((row, index) => ({ name: categories[index], value: row[source.valueFields[0]] })))) throw new Error('饼图与工具来源不一致');
  } else {
    if (source.valueFields.length !== spec.series.length * 2 || spec.series.some((series, index) => !equal(series.values, rows.map((row) => [row[source.valueFields[index * 2]], row[source.valueFields[index * 2 + 1]]])))) throw new Error('散点图与工具来源不一致');
  }
}
