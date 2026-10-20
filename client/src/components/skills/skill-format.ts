import { t } from '../../i18n/index.js';

export type SkillOrigin = 'manual' | 'import' | 'assistant';

export type SkillListItem = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  revision: number;
  origin: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type SkillVersionIndex = { revision: number; reason: string; source: string; createdAt: string };

export type SkillDetail = SkillListItem & {
  instructions: string;
  createdAt: string;
  versions: SkillVersionIndex[];
};

export type SkillDraftInput = {
  id?: string;
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
  expectedRevision?: number;
};

export type FromApproval = {
  approvalId: string;
  expectedProposalRevision: number;
  previewHash: string;
};

export type OpenSkillEditorDetail = {
  draft?: Partial<SkillDraftInput>;
  skillId?: string;
  fromApproval?: FromApproval;
};

export type SkillDiffLine = { type: 'same' | 'add' | 'remove'; text: string };
export type SkillDiff = {
  from?: number;
  to?: number;
  fields: Array<{ key: string; before: unknown; after: unknown }>;
  lines: SkillDiffLine[];
};

const fieldLabelKeys: Record<string, string> = {
  name: 'skills:field.name',
  description: 'skills:field.description',
  instructions: 'skills:field.body',
  enabled: 'skills:field.enabled',
};

export function skillOriginLabel(origin: string) {
  if (origin === 'manual' || origin === 'import' || origin === 'assistant') return t(`skills:origin.${origin}`);
  return origin;
}

export function skillSourceLabel(source: string) {
  if (source === 'manual' || source === 'import' || source === 'assistant' || source === 'rollback') return t(`skills:source.${source}`);
  if (source === 'editor-from-proposal') return t('skills:source.editor');
  return source;
}

export function skillFieldLabel(key: string) {
  return fieldLabelKeys[key] ? t(fieldLabelKeys[key]) : key;
}

export function skillValueText(value: unknown) {
  if (typeof value === 'boolean') return value ? t('skills:state.enabled') : t('skills:state.disabled');
  if (value == null) return '';
  return String(value);
}

export function skillImportErrorText(error: { message?: string; details?: unknown }) {
  const details = error.details && typeof error.details === 'object' ? error.details as { missing?: unknown } : {};
  const missing = Array.isArray(details.missing) ? details.missing.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
  if (missing.length) return t('skills:import.missing', { list: missing.join(t('skills:listJoiner')) });
  return error.message || t('skills:import.failed');
}

export function lineDiff(before: string, after: string): SkillDiffLine[] {
  const left = before.split('\n');
  const right = after.split('\n');
  const n = left.length;
  const m = right.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) dp[i][j] = left[i] === right[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const lines: SkillDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (left[i] === right[j]) { lines.push({ type: 'same', text: left[i] }); i += 1; j += 1; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { lines.push({ type: 'remove', text: left[i] }); i += 1; }
    else { lines.push({ type: 'add', text: right[j] }); j += 1; }
  }
  while (i < n) lines.push({ type: 'remove', text: left[i++] });
  while (j < m) lines.push({ type: 'add', text: right[j++] });
  return lines;
}

export function formatSkillDiff(diff: Pick<SkillDiff, 'fields' | 'lines'>) {
  return {
    fields: diff.fields.filter((field) => field.key !== 'instructions').map((field) => ({
      key: field.key,
      label: skillFieldLabel(field.key),
      before: skillValueText(field.before),
      after: skillValueText(field.after),
    })),
    lines: diff.lines,
  };
}

/** The only write the editor sends. Opening or closing a draft does not call this. */
export function skillSaveRequest(draft: SkillDraftInput, reason: string, fromApproval?: FromApproval) {
  const body: Record<string, unknown> = {
    name: draft.name,
    description: draft.description,
    instructions: draft.instructions,
    enabled: draft.enabled,
    reason,
  };
  if (fromApproval) body.fromApproval = fromApproval;
  if (draft.id) {
    body.expectedRevision = draft.expectedRevision;
    return { method: 'PATCH' as const, path: `/api/skills/${draft.id}`, body };
  }
  return { method: 'POST' as const, path: '/api/skills', body };
}

export function openSkillEditor(detail: OpenSkillEditorDetail) {
  window.dispatchEvent(new CustomEvent('wwa-open-skill-editor', { detail }));
}

type ReviewEntityLike = { entityType: string; entityId: string; operation: string; revisionBefore: number | null; fields: Array<{ key: string; before: unknown; after: unknown }> };

export function isSkillOnlyReview(entities: Array<{ entityType: string }>) {
  return entities.length > 0 && entities.every((entity) => entity.entityType === 'skill');
}

/** Editor prefill for a pending skill.* card. An update only carries the changed fields; the host loads the rest. */
export function skillProposalEditorDetail(entity: ReviewEntityLike, fromApproval: FromApproval): OpenSkillEditorDetail {
  const after = Object.fromEntries(entity.fields.map((field) => [field.key, field.after]));
  const draft: Partial<SkillDraftInput> = {};
  if (typeof after.name === 'string') draft.name = after.name;
  if (typeof after.description === 'string') draft.description = after.description;
  if (typeof after.instructions === 'string') draft.instructions = after.instructions;
  if (typeof after.enabled === 'boolean') draft.enabled = after.enabled;
  if (entity.operation === 'create') return { draft: { enabled: true, ...draft }, fromApproval };
  if (entity.revisionBefore != null) draft.expectedRevision = entity.revisionBefore;
  return { skillId: entity.entityId, draft, fromApproval };
}
