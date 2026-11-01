import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { sanitizeSvg } from '../agent/svg-sanitize.js';
import { DomainError } from '../domain/task.js';
import type { Prisma } from '@prisma/client';

// 学习主图：助手决定版式和关系，应用只认 data-node-id 标记的知识点。
// 保存前统一走 SVG 安全规则，并逐个核对标记是否是本主题仍在的知识点。

type Db = Pick<Prisma.TransactionClient, 'learningNode'>;
export type FigureRow = { id: string; mapId: string; svg: string; nodeIdsJson: string; revision: number; updatedAt: string };
export type LearningFigureView = { svg: string; revision: number; nodeIds: string[]; stale: boolean; missingNodeIds: string[]; removedNodeIds: string[]; updatedAt: string };

const learningFailure = (code: string, message: string, status = 400) => new DomainError(code, message, status);
const NODE_ATTRIBUTE = 'data-node-id';

type XmlElement = { getAttribute(name: string): string | null; setAttribute(name: string, value: string): void; hasAttribute(name: string): boolean; childNodes: ArrayLike<XmlElement>; nodeType: number };

function walk(node: XmlElement, visit: (element: XmlElement) => void) {
  if (node.nodeType === 1) visit(node);
  for (let index = 0; index < (node.childNodes?.length ?? 0); index++) walk(node.childNodes[index], visit);
}

/** Sanitize, resolve placeholder ids from nodeRefs, then check every tag against the live items of this topic. */
export async function prepareFigure(tx: Db, mapId: string, source: string, nodeRefs: Record<string, string> = {}) {
  let clean: string;
  try { clean = sanitizeSvg(source); }
  catch (error) { throw learningFailure('INVALID_FIGURE', `学习主图不符合 SVG 安全规则：${error instanceof Error ? error.message : String(error)}`); }
  const document = new DOMParser().parseFromString(clean, 'image/svg+xml') as unknown as XmlElement & { documentElement: XmlElement };
  const items = await tx.learningNode.findMany({ where: { mapId, deletedAt: null, kind: 'item' }, select: { id: true } });
  const live = new Set(items.map(item => item.id));
  const found = new Set<string>();
  const unknown = new Set<string>();
  walk(document.documentElement, element => {
    if (!element.hasAttribute(NODE_ATTRIBUTE)) return;
    const raw = element.getAttribute(NODE_ATTRIBUTE) ?? '';
    const id = Object.prototype.hasOwnProperty.call(nodeRefs, raw) ? nodeRefs[raw] : raw;
    if (!live.has(id)) { unknown.add(raw); return; }
    if (id !== raw) element.setAttribute(NODE_ATTRIBUTE, id);
    found.add(id);
  });
  if (unknown.size) throw learningFailure('INVALID_FIGURE_NODE', `学习主图引用了不属于这个主题的知识点：${[...unknown].slice(0, 5).join('、')}`);
  if (!found.size) throw learningFailure('INVALID_FIGURE', '学习主图至少要用 data-node-id 标出一个知识点');
  // Re-run the policy so the stored text is canonical after the placeholder swap.
  const svg = sanitizeSvg(new XMLSerializer().serializeToString(document as never));
  return { svg, nodeIds: [...found].sort() };
}

export function figureView(row: FigureRow | null, liveItemIds: string[]): LearningFigureView | null {
  if (!row) return null;
  let nodeIds: string[] = [];
  try { const parsed = JSON.parse(row.nodeIdsJson); if (Array.isArray(parsed)) nodeIds = parsed.filter((id): id is string => typeof id === 'string'); } catch { nodeIds = []; }
  const drawn = new Set(nodeIds);
  const live = new Set(liveItemIds);
  const missingNodeIds = liveItemIds.filter(id => !drawn.has(id));
  const removedNodeIds = nodeIds.filter(id => !live.has(id));
  return { svg: row.svg, revision: row.revision, nodeIds, stale: missingNodeIds.length > 0 || removedNodeIds.length > 0, missingNodeIds, removedNodeIds, updatedAt: row.updatedAt };
}
