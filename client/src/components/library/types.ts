import { intlLocale, t } from '../../i18n/index.js';

export type MaterialKind = 'document' | 'text' | 'markdown' | 'link' | 'thread' | 'attachment';
export type ExtractionStatus = 'queued' | 'running' | 'ready' | 'partial' | 'blocked' | 'failed' | 'unsupported';
export type LibraryViewName = 'all' | 'recent' | 'unfiled' | 'archived';

export type ExtractionError = { locator: Locator | null; code: string; message: string };
export type ExtractionInfo = { status: ExtractionStatus; errorCode: string | null; errors?: ExtractionError[] };

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
  extraction: ExtractionInfo;
};

export type MaterialVersion = {
  revision: number;
  createdAt: string;
  fileName: string | null;
  mimeType: string | null;
  hasAttachment: boolean;
  extraction: ExtractionInfo;
};

export type MaterialDetail = MaterialSummary & {
  uri: string | null;
  content: { revision: number; fileName: string | null; mimeType: string | null; hasAttachment: boolean; contentHash: string } | null;
  versions: MaterialVersion[];
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

export type LibraryHit = {
  chunkId: string;
  revision: number;
  locator: Locator;
  method: 'native' | 'ocr';
  snippet: string;
  highlightStart: number;
  highlightEnd: number;
};

export type LibraryRow = MaterialSummary & { score: number | null; hits: LibraryHit[] };

export type LibraryPreviewTarget = { materialId: string; revision: number | null; chunkId: string | null };

export type MaterialChunk = {
  id: string;
  materialId: string;
  revision: number;
  generation?: number;
  ordinal: number;
  text: string;
  method: string;
  locator: Locator;
};

export type MaterialSource =
  | { kind: 'text'; text: string; fileName: string | null; mimeType: string }
  | { kind: 'attachment'; revision: number; fileName: string; mimeType: string; href: string };

export type AnswerCitation = {
  id: string;
  materialId: string;
  revision: number;
  chunkId: string;
  titleSnapshot: string;
  quote: string;
  locator?: Locator;
  method?: 'native' | 'ocr';
};

export type AnswerResult = {
  status: string;
  paragraphs: Array<{ text: string; citationIds: string[] }>;
  citations: AnswerCitation[];
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

export const materialKinds: MaterialKind[] = ['document', 'text', 'markdown', 'link', 'thread', 'attachment'];

export function extractionLabel(status: ExtractionStatus) {
  return t(`library:extraction.${status}`);
}

export function kindLabel(kind: MaterialKind) {
  return t(`library:kind.${kind}`);
}

export function formatLocator(locator: Locator | null | undefined) {
  if (!locator) return '';
  if (locator.kind === 'line') return t('library:format.line', { start: locator.startLine, end: locator.endLine });
  if (locator.kind === 'paragraph') return t('library:format.paragraph', { paragraph: locator.paragraph });
  if (locator.kind === 'page') return t('library:format.page', { page: locator.page });
  if (locator.kind === 'sheet') return `${locator.sheet} ${locator.startCell}:${locator.endCell}`;
  if (locator.kind === 'slide') return t('library:format.slide', { slide: locator.slide });
  return t('library:format.image');
}

export function formatUpdated(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return t('library:format.updated', {
    month: date.getMonth() + 1,
    day: date.getDate(),
    time,
    monthDay: new Intl.DateTimeFormat(intlLocale(), { month: 'short', day: 'numeric' }).format(date),
  });
}

const kinds = new Set<MaterialKind>(['document', 'text', 'markdown', 'link', 'thread', 'attachment']);

export function normalizeRow(item: Partial<LibraryRow> & Pick<LibraryRow, 'id' | 'title'>): LibraryRow {
  const kind = item.kind && kinds.has(item.kind) ? item.kind : 'text';
  return {
    id: item.id,
    title: item.title,
    kind,
    revision: item.revision ?? 0,
    organizationRevision: item.organizationRevision ?? 0,
    topicId: item.topicId ?? null,
    folderId: item.folderId ?? null,
    fileName: item.fileName ?? null,
    mimeType: item.mimeType ?? null,
    archivedAt: item.archivedAt ?? null,
    createdAt: item.createdAt ?? item.updatedAt ?? '',
    updatedAt: item.updatedAt ?? item.createdAt ?? '',
    tags: item.tags ?? [],
    linkedTaskCount: item.linkedTaskCount ?? 0,
    extraction: item.extraction ?? { status: 'queued', errorCode: null, errors: [] },
    score: item.score ?? null,
    hits: Array.isArray(item.hits) ? item.hits : [],
  };
}
