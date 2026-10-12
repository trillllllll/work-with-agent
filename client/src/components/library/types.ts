export type MaterialKind = 'text' | 'markdown' | 'link' | 'thread' | 'attachment';
export type ExtractionStatus = 'queued' | 'running' | 'ready' | 'partial' | 'blocked' | 'failed' | 'unsupported';
export type LibraryViewName = 'all' | 'recent' | 'unfiled' | 'archived';

export type MaterialSummary = {
  id: string;
  title: string;
  kind: MaterialKind;
  revision: number;
  organizationRevision: number;
  topicId: string | null;
  folderId: string | null;
  fileName: string | null;
  mimeType: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  tags: Array<{ id: string; name: string }>;
  linkedTaskCount: number;
  extraction: { status: ExtractionStatus; errorCode: string | null };
};

export type MaterialDetail = MaterialSummary & {
  uri: string | null;
  content: { revision: number; fileName: string | null; mimeType: string | null; hasAttachment: boolean; contentHash: string } | null;
  versions: Array<{ revision: number; createdAt: string; fileName: string | null; mimeType: string | null; hasAttachment: boolean; extraction: { status: ExtractionStatus; errorCode: string | null } }>;
};

export type LibraryFolder = { id: string; parentId: string | null; name: string; revision: number };
export type LibraryTag = { id: string; name: string; revision: number };
export type LinkedTask = { id: string; title: string; topicId: string | null; revision: number; status: string; manual: boolean; legacy: boolean };
export type Page<T> = { items: T[]; total: number; nextCursor: number | null };

export type Locator =
  | { kind: 'line'; startLine: number; endLine: number; start: number; end: number }
  | { kind: 'paragraph'; paragraph: number; start: number; end: number }
  | { kind: 'page'; page: number; start: number; end: number }
  | { kind: 'sheet'; sheet: string; startCell: string; endCell: string; start: number; end: number }
  | { kind: 'slide'; slide: number; start: number; end: number }
  | { kind: 'image'; image: 1; start: number; end: number };

export type SearchHit = {
  id: string;
  revision: number;
  score: number;
  title: string;
  updatedAt: string;
  hits: Array<{ chunkId: string; locator: Locator; method: string; snippet: string; highlightStart: number; highlightEnd: number }>;
};

export type LibraryFilters = {
  folderId?: string;
  recursive?: boolean;
  tagIds?: string[];
  taskId?: string;
  taskTopicId?: string;
  kind?: MaterialKind;
  archived?: 'exclude' | 'only' | 'include';
  view?: LibraryViewName;
};

export const extractionCopy: Record<ExtractionStatus, string> = {
  queued: '等待解析',
  running: '正在解析',
  ready: '可搜索正文',
  partial: '部分内容可搜索',
  blocked: '需要配置识字模型',
  failed: '解析失败',
  unsupported: '暂不支持正文解析',
};

export const kindLabels: Record<MaterialKind, string> = {
  text: '文本',
  markdown: 'Markdown',
  link: '链接',
  thread: '会话',
  attachment: '附件',
};

export function formatLocator(locator: Locator) {
  if (locator.kind === 'line') return `第 ${locator.startLine}–${locator.endLine} 行`;
  if (locator.kind === 'paragraph') return `第 ${locator.paragraph} 段`;
  if (locator.kind === 'page') return `第 ${locator.page} 页`;
  if (locator.kind === 'sheet') return `${locator.sheet} ${locator.startCell}:${locator.endCell}`;
  if (locator.kind === 'slide') return `第 ${locator.slide} 页`;
  return '图片';
}

export function formatUpdated(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
