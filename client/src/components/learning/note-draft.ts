import type { LearningNode } from './learning-model.js';
import type { Command } from '@/lib/platform.js';
export type NoteFields = Pick<LearningNode, 'title' | 'detail' | 'status'>;
export type NoteDraft = NoteFields & { base: NoteFields; revision: number; pending?: { requestId: string; command: Command } };
export const noteFields = (node: NoteFields): NoteFields => ({ title: node.title, detail: node.detail, status: node.status });
export const freshDraft = (node: LearningNode): NoteDraft => ({ ...noteFields(node), base: noteFields(node), revision: node.revision });
export const draftDirty = (draft: NoteDraft) => (['title','detail','status'] as const).some(key => draft[key] !== draft.base[key]);
export function rebaseDraft(draft: NoteDraft, node: LearningNode): NoteDraft {
  const next = freshDraft(node);
  for (const key of ['title','detail','status'] as const) if (draft[key] !== draft.base[key]) next[key] = draft[key];
  return next;
}
const keyFor = (scope: string, id: string) => `dovun-learning-note-v1:${scope}:${id}`;
export function readNoteDraft(scope: string, node: LearningNode): NoteDraft {
  try {
    const value = JSON.parse(sessionStorage.getItem(keyFor(scope, node.id)) ?? 'null') as NoteDraft | null;
    if (value && Number.isInteger(value.revision) && value.revision > 0 && value.base && ['title','detail','status'].every(key => typeof value[key as keyof NoteFields] === 'string' && typeof value.base[key as keyof NoteFields] === 'string')) return { ...value, pending: value.pending?.command?.targetId === node.id && typeof value.pending.requestId === 'string' ? value.pending : undefined };
  } catch { /* Corrupt or unavailable tab storage must not prevent editing. */ }
  return freshDraft(node);
}
export function storeNoteDraft(scope: string, id: string, draft: NoteDraft): boolean {
  try { if (draftDirty(draft) || draft.pending) sessionStorage.setItem(keyFor(scope,id), JSON.stringify(draft)); else sessionStorage.removeItem(keyFor(scope,id)); return true; } catch { return false; }
}
