import type { LearningNode } from './learning-model.js';

export type LearningFigureView = { svg: string; revision: number; nodeIds: string[]; stale: boolean; missingNodeIds: string[]; removedNodeIds: string[]; updatedAt: string };

export type FigureNodeState = { status: string; current: boolean; selected: boolean; title: string } | null;

/** How one tagged shape should look. Unknown or removed ids render dimmed and are not clickable. */
export function figureNodeState(id: string, nodes: LearningNode[], currentId?: string, selectedId?: string): FigureNodeState {
  const node = nodes.find(item => item.id === id && item.kind === 'item');
  if (!node) return null;
  return { status: node.status, current: node.id === currentId, selected: node.id === selectedId, title: node.title };
}

/** Only knowledge points of this topic can be opened from the figure. */
export function figurePick(id: string | null | undefined, nodes: LearningNode[]) {
  if (!id) return null;
  return nodes.some(node => node.id === id && node.kind === 'item') ? id : null;
}

/** Inline SVGs share the page's id space. Prefix ids and their url(#…)/href references so two figures never collide. */
export function scopeSvgIds(svg: string, prefix: string) {
  if (typeof DOMParser === 'undefined' || !svg.includes('id=')) return svg;
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const ids = new Map<string, string>();
  document.querySelectorAll('[id]').forEach(element => { const next = `${prefix}-${element.id}`; ids.set(element.id, next); element.id = next; });
  if (!ids.size) return svg;
  document.querySelectorAll('*').forEach(element => {
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name === 'id') continue;
      const replaced = attribute.value.replace(/url\(#([^)]+)\)/g, (match, id: string) => ids.has(id) ? `url(#${ids.get(id)})` : match)
        .replace(/^#(.+)$/, (match, id: string) => (attribute.name === 'href' || attribute.name === 'xlink:href') && ids.has(id) ? `#${ids.get(id)}` : match);
      if (replaced !== attribute.value) element.setAttribute(attribute.name, replaced);
    }
  });
  return new XMLSerializer().serializeToString(document.documentElement);
}
