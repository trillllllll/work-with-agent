import { intlLocale, t } from '../i18n/index.js';
import { recurrenceLabel } from './recurrence.js';

export type ProposalKind = 'task' | 'memory' | 'skill' | 'other';

export const taskEditableFields = ['title', 'description', 'priority', 'status', 'dueDate'] as const;
export const memoryEditableFields = ['title', 'content', 'reason'] as const;
export const skillEditableFields = ['description', 'instructions', 'reason'] as const;

const taskStatuses = new Set(['todo', 'doing', 'blocked', 'done']);
const priorities = new Set(['none', 'low', 'medium', 'high']);
const hiddenKeys = new Set([
  'topicId', 'parentId', 'targetId', 'taskId', 'materialId', 'memoryId', 'tagIds', 'taskIds', 'materialIds', 'memoryIds',
  'orderedTaskIds', 'evidence', 'labels', 'origin', 'importance', 'kind', 'clientRef', 'entityId', 'expectedRevision',
  'expectedParentRevision', 'expectedRevisions', 'completeChildren', 'enabled', 'hash', 'attachmentBase64',
]);

export type FieldDisplay = { kind: 'text'; text: string } | { kind: 'list'; items: string[] } | { kind: 'omit' };

export type AffectedTask = { id: string; title: string; revision?: number; status?: string; topicId?: string | null };
export type EvidenceSummary = {
  type: string;
  id: string;
  revision: number;
  title?: string;
  topicId?: string | null;
  topicName?: string | null;
  status?: string;
  unavailable?: boolean;
};
export type PreviewEntry = { detail: Record<string, unknown>; after?: unknown };

export function commandFamily(kind: string): ProposalKind {
  if (kind.startsWith('task.')) return 'task';
  if (kind.startsWith('memory.')) return 'memory';
  if (kind.startsWith('skill.')) return 'skill';
  return 'other';
}

export function editableFieldsFor(kind: string): readonly string[] {
  const family = commandFamily(kind);
  if (family === 'task') return taskEditableFields;
  if (family === 'memory') return memoryEditableFields;
  if (family === 'skill') return skillEditableFields;
  return [];
}

export function isEditableField(kind: string, field: string): boolean {
  return editableFieldsFor(kind).includes(field);
}

export function isTechnicalKey(key: string): boolean {
  return hiddenKeys.has(key) || key.endsWith('Id') || key.endsWith('Ids');
}

export function importanceBand(value: number): 'low' | 'mid' | 'high' {
  if (value <= 2) return 'low';
  if (value >= 4) return 'high';
  return 'mid';
}

function formatDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(value);
  if (!match) return value;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day, match[4] ? Number(match[4]) : 0, match[5] ? Number(match[5]) : 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return value;
  const dayText = new Intl.DateTimeFormat(intlLocale(), { month: 'long', day: 'numeric', weekday: 'short' }).format(date);
  if (!match[4]) return dayText;
  const time = new Intl.DateTimeFormat(intlLocale(), { hour: '2-digit', minute: '2-digit' }).format(date);
  return `${dayText} ${time}`;
}

function scalarText(field: string, value: string): string {
  if ((field === 'priority') && priorities.has(value)) return t(`app:priority.${value}`);
  if (field === 'status' && taskStatuses.has(value)) return t(`app:status.${value}`);
  if (field === 'status' && value === 'active') return t('proposals:value.active');
  if (field === 'status' && value === 'retired') return t('proposals:value.retired');
  if (field === 'status' && value === 'superseded') return t('proposals:value.superseded');
  if (field === 'dueDate' || field === 'scheduledStart' || field === 'scheduledEnd') return formatDate(value);
  if (field === 'recurrenceRule') return recurrenceLabel(value);
  return value;
}

/** Human text for a field. Objects never become "[object Object]"; they are omitted from summaries. */
export function formatFieldValue(field: string, value: unknown): FieldDisplay {
  if (value == null) return { kind: 'text', text: '' };
  if (typeof value === 'string') return { kind: 'text', text: scalarText(field, value) };
  if (typeof value === 'number' && Number.isFinite(value)) return { kind: 'text', text: String(value) };
  if (typeof value === 'boolean') return { kind: 'text', text: value ? t('proposals:value.yes') : t('proposals:value.no') };
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (const item of value) {
      if (item == null) continue;
      if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
        items.push(String(item));
        continue;
      }
      return { kind: 'omit' };
    }
    return { kind: 'list', items };
  }
  if (typeof value === 'object') return { kind: 'omit' };
  const text = String(value);
  if (text.includes('[object Object]')) return { kind: 'omit' };
  return { kind: 'text', text };
}

/** Flatten an input record the way a summary would. Omitted objects contribute nothing. */
export function inputSummaryText(input: Record<string, unknown> | undefined): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(input ?? {})) {
    const display = formatFieldValue(key, value);
    if (display.kind === 'text' && display.text) parts.push(display.text);
    if (display.kind === 'list') parts.push(...display.items);
  }
  return parts.join('\n');
}

export function readableFields(input: Record<string, unknown> | undefined): Array<{ key: string; display: FieldDisplay }> {
  const rows: Array<{ key: string; display: FieldDisplay }> = [];
  for (const [key, value] of Object.entries(input ?? {})) {
    if (isTechnicalKey(key)) continue;
    const display = formatFieldValue(key, value);
    if (display.kind === 'omit') continue;
    if (display.kind === 'text' && !display.text) continue;
    if (display.kind === 'list' && !display.items.length) continue;
    rows.push({ key, display });
  }
  return rows;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function previewEntries(preview: unknown): PreviewEntry[] {
  let value = preview;
  if (typeof value === 'string') {
    try { value = JSON.parse(value) as unknown; } catch { return []; }
  }
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = asRecord(item);
    if (!record) return { detail: {} };
    const detail = asRecord(record.detail);
    return detail ? { detail, after: record.after } : { detail: record };
  });
}

export function affectedTasksOf(detail: Record<string, unknown> | undefined): AffectedTask[] {
  const raw = detail?.affectedTasks;
  if (!Array.isArray(raw)) return [];
  const tasks: AffectedTask[] = [];
  for (const item of raw) {
    const row = asRecord(item);
    if (!row || typeof row.id !== 'string') continue;
    tasks.push({
      id: row.id,
      title: typeof row.title === 'string' ? row.title : '',
      ...(typeof row.revision === 'number' ? { revision: row.revision } : {}),
      ...(typeof row.status === 'string' ? { status: row.status } : {}),
      ...(typeof row.topicId === 'string' || row.topicId === null ? { topicId: row.topicId } : {}),
    });
  }
  return tasks;
}

export function evidenceSummariesOf(detail: Record<string, unknown> | undefined): EvidenceSummary[] | null {
  if (!detail || !Object.prototype.hasOwnProperty.call(detail, 'evidenceSummaries')) return null;
  if (!Array.isArray(detail.evidenceSummaries)) return [];
  const summaries: EvidenceSummary[] = [];
  for (const item of detail.evidenceSummaries) {
    const row = asRecord(item);
    if (!row || typeof row.type !== 'string' || typeof row.id !== 'string') continue;
    summaries.push({
      type: row.type,
      id: row.id,
      revision: typeof row.revision === 'number' ? row.revision : 0,
      ...(typeof row.title === 'string' ? { title: row.title } : {}),
      ...(typeof row.topicId === 'string' || row.topicId === null ? { topicId: row.topicId } : {}),
      ...(typeof row.topicName === 'string' || row.topicName === null ? { topicName: row.topicName } : {}),
      ...(typeof row.status === 'string' ? { status: row.status } : {}),
      ...(row.unavailable === true ? { unavailable: true } : {}),
    });
  }
  return summaries;
}

export function legacyEvidence(value: unknown): Array<{ type: string; id: string; revision: number }> {
  if (!Array.isArray(value)) return [];
  const refs: Array<{ type: string; id: string; revision: number }> = [];
  for (const item of value) {
    const row = asRecord(item);
    if (!row || typeof row.type !== 'string' || typeof row.id !== 'string') continue;
    refs.push({ type: row.type, id: row.id, revision: typeof row.revision === 'number' ? row.revision : 0 });
  }
  return refs;
}
