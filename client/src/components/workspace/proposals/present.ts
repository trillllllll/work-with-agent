import type { QueryClient } from '@tanstack/react-query';
import { ApiError } from '@/lib/api.js';
import { t } from '@/i18n/index.js';
import { operationNames, parseStored } from '@/lib/platform.js';
import type { ProposalAnalysis, ProposalCommand } from '@/lib/proposal-group.js';
import type { FieldDisplay } from '@/lib/proposal-fields.js';
import type { Proposal, ProposalResult } from './types.js';

export type TopicRef = { id: string; name: string; color?: string | null };

const labeledFields = new Set(['title', 'name', 'description', 'content', 'dueDate', 'priority', 'status', 'resultSummary', 'reason', 'instructions']);

export function fieldLabel(key: string): string {
  return labeledFields.has(key) ? t(`proposals:fields.${key}`) : key;
}

export function displayText(display: FieldDisplay): string {
  const separator = t('proposals:listSeparator');
  if (display.kind === 'text') return display.text;
  if (display.kind === 'list') return display.items.join(separator);
  return '';
}

export function typeLine(analysis: ProposalAnalysis): string {
  if (analysis.items.length <= 1) {
    const kind = analysis.items[0]?.kind ?? '';
    return (kind && operationNames[kind]) || kind;
  }
  const parts: string[] = [];
  if (analysis.createdCount) parts.push(t('proposals:badge.createdCount', { count: analysis.createdCount }));
  if (analysis.updatedCount) parts.push(t('proposals:badge.updatedCount', { count: analysis.updatedCount }));
  if (analysis.deletedCount) parts.push(t('proposals:badge.deletedCount', { count: analysis.deletedCount }));
  if (!parts.length) return t(`proposals:type.${analysis.type}`);
  return parts.join(' · ');
}

export function topicChips(ids: Array<string | null>, topics: TopicRef[] | undefined): Array<{ key: string; name: string; color: string }> {
  const chips: Array<{ key: string; name: string; color: string }> = [];
  for (const id of ids) {
    if (id === null) {
      chips.push({ key: 'inbox', name: t('proposals:inbox'), color: 'slate' });
      continue;
    }
    if (!topics) continue;
    const found = topics.find((topic) => topic.id === id);
    if (found) chips.push({ key: id, name: found.name, color: found.color || 'slate' });
  }
  return chips;
}

function topicNames(ids: Array<string | null>, topics: TopicRef[] | undefined): string[] | null {
  const names: string[] = [];
  for (const id of ids) {
    if (id === null) {
      names.push(t('proposals:inbox'));
      continue;
    }
    if (!topics) return null;
    const found = topics.find((topic) => topic.id === id);
    if (found) names.push(found.name);
  }
  return names;
}

export function impactLine(analysis: ProposalAnalysis, topics: TopicRef[] | undefined): string | null {
  const single = analysis.items.length === 1 ? analysis.items[0] : null;
  if (single?.kind === 'task.update') return null;
  if (analysis.affectedTasks.length > 6) return t('proposals:impact.taskCount', { count: analysis.affectedTasks.length });
  if (analysis.affectedTasks.length) {
    const titles = analysis.affectedTasks.map((task) => task.title || t('proposals:head.untitled'));
    return t('proposals:impact.tasks', { tasks: titles.join(t('proposals:listSeparator')) });
  }
  if (!single) return analysis.items.length > 1 ? t('proposals:impact.none') : null;
  if (single.kind === 'task.create') return t('proposals:impact.taskCreate');
  if (single.kind.startsWith('memory.')) {
    const names = topicNames(analysis.topicIds, topics);
    if (names === null) return null;
    const onlyInbox = names.length > 0 && analysis.topicIds.every((id) => id === null);
    if (!names.length || onlyInbox) {
      if (!names.length && analysis.topicIds.some((id) => id)) return null;
      return t('proposals:impact.memoryInbox');
    }
    return t('proposals:impact.memory', { topic: names.join(t('proposals:listSeparator')) });
  }
  if (single.kind === 'skill.create') return t('proposals:impact.skillCreate');
  if (single.kind === 'skill.update') return t('proposals:impact.skillUpdate');
  return null;
}

export function cloneCommands(value: unknown): ProposalCommand[] {
  const parsed = parseStored<unknown>(value as string | undefined, value);
  if (!Array.isArray(parsed)) return [];
  const commands: ProposalCommand[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || typeof (item as ProposalCommand).kind !== 'string') continue;
    const command = item as ProposalCommand;
    commands.push({ ...command, input: { ...(command.input ?? {}) } });
  }
  return commands;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.keys(record).sort().reduce<Record<string, unknown>>((acc, key) => {
      if (record[key] !== undefined) acc[key] = stable(record[key]);
      return acc;
    }, {});
  }
  return value;
}

export function sameCommands(left: ProposalCommand[], right: ProposalCommand[]): boolean {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

export function cardDataState(status: string, mode: 'view' | 'edit' | 'reject', hasError: boolean): string {
  if (status === 'executed' || status === 'applied') return 'executed';
  if (status === 'rejected') return 'rejected';
  if (hasError) return 'error';
  if (mode === 'edit') return 'editing';
  if (mode === 'reject') return 'rejecting';
  return 'pending';
}

export function describeError(error: unknown): { message: string; conflict: boolean } {
  if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') return { message: t('proposals:error.conflict'), conflict: true };
  if (error instanceof Error && error.message) return { message: error.message, conflict: false };
  return { message: t('proposals:error.generic'), conflict: false };
}

export function rejectedReason(proposal: Proposal): string {
  if (proposal.status !== 'rejected') return '';
  const value = parseStored<ProposalResult | null>(proposal.result ?? null, null);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  return typeof value.reason === 'string' ? value.reason.trim() : '';
}

export function invalidateProposalViews(client: QueryClient) {
  return Promise.all([
    client.invalidateQueries({ queryKey: ['proposals'] }),
    client.invalidateQueries({ queryKey: ['tasks'] }),
    client.invalidateQueries({ queryKey: ['proposals', 'count'] }),
  ]);
}

export function recordOf(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function previewText(preview: unknown): string {
  if (typeof preview === 'string') return preview;
  try { return JSON.stringify(preview, null, 2); } catch { return ''; }
}
