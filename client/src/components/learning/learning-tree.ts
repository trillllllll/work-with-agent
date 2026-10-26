export type LearningTreeNode = {
  id: string; mapId: string; parentId: string | null; kind: string; title: string;
  detail: string; status: string; mastery: number; sortOrder: number; revision: number;
  children: LearningTreeNode[];
};

type ChartNode = { name: string; value?: number; nodeId?: string; itemStyle: { color: string; borderColor: string }; label: { color: string }; children: ChartNode[]; collapsed?: boolean };

function toChartNode(node: LearningTreeNode, dark: boolean, statusDone: string): ChartNode {
  const hue = Math.round(node.mastery * 1.2);
  const color = node.status === statusDone ? `hsl(150 45% ${dark ? 38 : 40}%)` : node.kind === 'item' ? `hsl(${hue} 42% ${dark ? 42 : 44}%)` : dark ? '#416e85' : '#a9c3ce';
  return {
    name: node.title,
    value: node.mastery,
    nodeId: node.id,
    itemStyle: { color, borderColor: dark ? '#1f2937' : '#ffffff' },
    label: { color: dark ? '#d4d4d4' : '#343434' },
    children: node.children.map((child) => toChartNode(child, dark, statusDone)),
  };
}

// ECharts lays out only the first root. Group the forest under a display-only root.
export function learningChartData(tree: LearningTreeNode[], title: string, dark: boolean): ChartNode[] {
  if (!tree.length) return [];
  return [{
    name: title,
    itemStyle: { color: dark ? '#416e85' : '#a9c3ce', borderColor: dark ? '#1f2937' : '#ffffff' },
    label: { color: dark ? '#d4d4d4' : '#343434' },
    collapsed: false,
    children: tree.map((node) => toChartNode(node, dark, 'done')),
  }];
}
