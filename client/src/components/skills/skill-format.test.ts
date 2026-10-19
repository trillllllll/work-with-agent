import { describe, expect, it } from 'vitest';
import { formatSkillDiff, isSkillOnlyReview, lineDiff, skillImportErrorText, skillProposalEditorDetail, skillSaveRequest } from './skill-format.js';

describe('skill formatting', () => {
  it('shows the missing SKILL.md fields from a 400', () => {
    expect(skillImportErrorText({ message: '别的说法', details: { missing: ['name', '正文'] } })).toBe('SKILL.md 缺少：name、正文');
    expect(skillImportErrorText({ message: 'SKILL.md 缺少：frontmatter' })).toBe('SKILL.md 缺少：frontmatter');
    expect(skillImportErrorText({})).toBe('导入失败');
  });

  it('renders a field change and a line diff', () => {
    const view = formatSkillDiff({
      fields: [
        { key: 'description', before: '旧描述', after: '新描述' },
        { key: 'enabled', before: false, after: true },
        { key: 'instructions', before: '旧行', after: '新行' },
      ],
      lines: lineDiff('保持\n旧行', '保持\n新行'),
    });
    expect(view.fields).toEqual([
      { key: 'description', label: '描述', before: '旧描述', after: '新描述' },
      { key: 'enabled', label: '启用', before: '停用', after: '启用' },
    ]);
    expect(view.lines).toEqual([
      { type: 'same', text: '保持' },
      { type: 'remove', text: '旧行' },
      { type: 'add', text: '新行' },
    ]);
  });

  it('builds a create or update body only for an explicit save', () => {
    const draft = { name: '周报', description: '周五整理', instructions: '先列任务', enabled: false };
    expect(skillSaveRequest(draft, '')).toEqual({ method: 'POST', path: '/api/skills', body: { ...draft, reason: '' } });
    const fromApproval = { approvalId: 'ap1', expectedProposalRevision: 2, previewHash: 'abc' };
    expect(skillSaveRequest({ ...draft, id: 'sk1', expectedRevision: 3, enabled: true }, '补一步', fromApproval)).toEqual({
      method: 'PATCH',
      path: '/api/skills/sk1',
      body: { ...draft, enabled: true, expectedRevision: 3, reason: '补一步', fromApproval },
    });
  });
});

describe('skill proposal editor detail', () => {
  const fromApproval = { approvalId: 'ap1', expectedProposalRevision: 1, previewHash: 'h' };
  it('prefills a create card and defaults to enabled', () => {
    const entity = { entityType: 'skill', entityId: 'sk-new', operation: 'create', revisionBefore: null, fields: [
      { key: 'name', before: null, after: '周报' }, { key: 'description', before: null, after: '周五' }, { key: 'instructions', before: null, after: '步骤' },
    ] };
    expect(skillProposalEditorDetail(entity, fromApproval)).toEqual({ draft: { enabled: true, name: '周报', description: '周五', instructions: '步骤' }, fromApproval });
  });

  it('overlays only the changed fields of an update on the loaded skill', () => {
    const entity = { entityType: 'skill', entityId: 'sk1', operation: 'update', revisionBefore: 2, fields: [{ key: 'instructions', before: '旧', after: '新' }, { key: 'enabled', before: true, after: false }] };
    expect(skillProposalEditorDetail(entity, fromApproval)).toEqual({ skillId: 'sk1', draft: { instructions: '新', enabled: false, expectedRevision: 2 }, fromApproval });
    expect(isSkillOnlyReview([{ entityType: 'skill' }])).toBe(true);
    expect(isSkillOnlyReview([{ entityType: 'skill' }, { entityType: 'task' }])).toBe(false);
    expect(isSkillOnlyReview([])).toBe(false);
  });
});
