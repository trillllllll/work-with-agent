export type LearningTreeNode = {
  id: string; mapId: string; parentId: string | null; kind: string; title: string;
  detail: string; status: string; mastery: number; sortOrder: number; revision: number;
  children: LearningTreeNode[];
};
