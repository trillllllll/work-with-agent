import { describe, expect, it } from 'vitest';
import { init, use } from 'echarts/core';
import { TreeChart } from 'echarts/charts';
import { SVGRenderer } from 'echarts/renderers';
import { learningChartData, type LearningTreeNode } from './learning-tree.js';

use([TreeChart, SVGRenderer]);
const topic = (id: string, children: LearningTreeNode[] = []): LearningTreeNode => ({
  id, mapId: 'go', parentId: null, kind: 'topic', title: id, detail: '', status: 'todo',
  mastery: 0, sortOrder: 0, revision: 1, children,
});

describe('learning map forest layout', () => {
  it('renders all 13 sibling topics with the actual ECharts layout engine', () => {
    const nodes = Array.from({ length: 13 }, (_, i) => topic(`topic-${i + 1}`));
    const chart = init(null, undefined, { renderer: 'svg', ssr: true, width: 900, height: 540 });
    try {
      chart.setOption({ animation: false, series: [{ type: 'tree', data: learningChartData(nodes, 'Go 基础', true), initialTreeDepth: 2, expandAndCollapse: true }] });
      const svg = chart.renderToSVGString();
      for (const node of nodes) expect(svg).toContain(`>${node.title}</text>`);
      expect(svg).toContain('>Go 基础</text>');
    } finally { chart.dispose(); }
  });

  it('keeps the display root free of business identity and mastery, and leaves source data intact', () => {
    const item = { ...topic('练习'), parentId: '环境', kind: 'item', mastery: 70, status: 'learning' };
    const nodes = [topic('环境', [item])];
    const snapshot = JSON.stringify(nodes);
    const [root] = learningChartData(nodes, 'Go 基础', false);
    expect(root.nodeId).toBeUndefined();
    expect(root.value).toBeUndefined();
    expect(root.collapsed).toBe(false);
    expect(root.children[0].children[0]).toMatchObject({ nodeId: '练习', value: 70 });
    expect(JSON.stringify(nodes)).toBe(snapshot);
    expect(learningChartData(nodes, '另一地图', false)[0].name).toBe('另一地图');
    expect(learningChartData([], '空地图', false)).toEqual([]);
  });
});
