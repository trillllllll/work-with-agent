import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../infrastructure/prisma.js';
import { createSkill, deleteSkill, diffLines, diffSkill, getSkill, importSkill, listSkills, parseSkillMarkdown, restoreSkill, rollbackSkill, updateSkill } from './skills.js';

const ids: string[] = [];
let seq = 0;
const stamp = () => `技能-${Date.now()}-${seq += 1}`;

async function make(overrides: Partial<{ name: string; description: string; instructions: string; enabled: boolean }> = {}) {
  const skill = await createSkill({ name: overrides.name ?? stamp(), description: overrides.description ?? '描述', instructions: overrides.instructions ?? '正文', enabled: overrides.enabled });
  ids.push(skill.id);
  return skill;
}

describe('skill persistence', () => {
  afterEach(async () => {
    if (!ids.length) return;
    await prisma.skillVersion.deleteMany({ where: { skillId: { in: ids } } });
    await prisma.skill.deleteMany({ where: { id: { in: ids } } });
    ids.length = 0;
  });

  it('creates, rejects duplicate names, hides soft deletes, reuses a released name, and blocks a conflicting restore', async () => {
    const name = stamp();
    const created = await make({ name, instructions: '第一版' });
    expect(created.revision).toBe(1);
    expect(created.enabled).toBe(false);
    expect(created.origin).toBe('manual');
    await expect(createSkill({ name, description: '另一份', instructions: '另一份正文' })).rejects.toMatchObject({ code: 'SKILL_NAME_TAKEN', status: 409, details: { skillId: created.id, revision: 1 } });
    const renamed = await updateSkill(created.id, { expectedRevision: 1, name: stamp() });
    ids.push(renamed.id);
    const occupier = await make({ name });
    await expect(updateSkill(renamed.id, { expectedRevision: renamed.revision, name })).rejects.toMatchObject({ code: 'SKILL_NAME_TAKEN', status: 409, details: { skillId: occupier.id, revision: occupier.revision } });
    expect((await prisma.skill.findUniqueOrThrow({ where: { id: renamed.id } })).name).not.toBe(name);
    await deleteSkill(occupier.id, occupier.revision);
    expect((await listSkills()).map((item) => item.id)).not.toContain(occupier.id);
    expect((await listSkills({ deleted: true })).map((item) => item.id)).toContain(occupier.id);
    const reused = await make({ name });
    expect(reused.id).not.toBe(occupier.id);
    await expect(restoreSkill(occupier.id)).rejects.toMatchObject({ code: 'SKILL_NAME_TAKEN', status: 409, details: { skillId: reused.id } });
    expect((await prisma.skill.findUniqueOrThrow({ where: { id: occupier.id } })).deletedAt).toBeTruthy();
    await deleteSkill(reused.id, reused.revision);
    const restored = await restoreSkill(occupier.id);
    expect(restored.deletedAt).toBeNull();
    expect(restored.enabled).toBe(false);
    expect((await listSkills()).map((item) => item.id)).toContain(occupier.id);
    const detail = await getSkill(occupier.id);
    expect(detail.versions).toHaveLength(1);
    expect(detail.instructions).toBe('正文');
  });

  it('keeps every version, rejects a stale revision without writing, and rolls back by appending', async () => {
    const skill = await make({ instructions: 'v1 正文', description: 'v1 描述' });
    const second = await updateSkill(skill.id, { expectedRevision: 1, instructions: 'v2 正文', reason: '补充步骤' });
    expect(second.revision).toBe(2);
    const [kept, lost] = await Promise.allSettled([
      updateSkill(skill.id, { expectedRevision: 2, description: '窗口甲' }),
      updateSkill(skill.id, { expectedRevision: 2, description: '窗口乙' }),
    ]);
    const fulfilled = [kept, lost].filter((item) => item.status === 'fulfilled');
    const rejected = [kept, lost].filter((item) => item.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'VERSION_CONFLICT', status: 409, details: { currentRevision: 3 } });
    const current = await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } });
    expect(current.revision).toBe(3);
    expect(current.instructions).toBe('v2 正文');
    expect(['窗口甲', '窗口乙']).toContain(current.description);
    const rolled = await rollbackSkill(skill.id, { expectedRevision: current.revision, targetRevision: 1 });
    expect(rolled.revision).toBe(4);
    expect(rolled.instructions).toBe('v1 正文');
    expect(rolled.description).toBe('v1 描述');
    const versions = await prisma.skillVersion.findMany({ where: { skillId: skill.id }, orderBy: { revision: 'asc' } });
    expect(versions.map((version) => version.revision)).toEqual([1, 2, 3, 4]);
    expect(versions[1]?.instructions).toBe('v2 正文');
    expect(versions[3]?.instructions).toBe('v1 正文');
    expect(versions[3]?.reason).toBe('回滚到 v1');
    expect(versions[3]?.source).toBe('rollback');
    const enabled = await updateSkill(skill.id, { expectedRevision: rolled.revision, enabled: true });
    const disabled = await updateSkill(skill.id, { expectedRevision: enabled.revision, enabled: false });
    const reasons = (await prisma.skillVersion.findMany({ where: { skillId: skill.id, revision: { in: [enabled.revision, disabled.revision] } }, orderBy: { revision: 'asc' } })).map((version) => version.reason);
    expect(reasons).toEqual(['启用', '停用']);
    expect(disabled.instructions).toBe('v1 正文');
    const diff = await diffSkill(skill.id, 1, 2);
    expect(diff.fields).toEqual([{ key: 'instructions', before: 'v1 正文', after: 'v2 正文' }]);
    expect(diff.lines).toEqual([{ type: 'remove', text: 'v1 正文' }, { type: 'add', text: 'v2 正文' }]);
  });

  it('parses SKILL.md and applies version or rename without writing on an unresolved clash', async () => {
    expect(parseSkillMarkdown('---\nname: 周报\ndescription: 每周五整理\nlicense: MIT\n---\n先收集，再发送\n')).toEqual({ name: '周报', description: '每周五整理', instructions: '先收集，再发送' });
    expect(parseSkillMarkdown('---\nname: "带引号"\ndescription: \'单引号描述\'\n---\n正文\n')).toEqual({ name: '带引号', description: '单引号描述', instructions: '正文' });
    expect(parseSkillMarkdown('---\nname: 周报\ndescription: |\n  第一行\n  第二行\n---\n步骤\n')).toEqual({ name: '周报', description: '第一行\n第二行', instructions: '步骤' });
    expect(parseSkillMarkdown('---\nname: 周报\ndescription: >\n  折行\n  成一段\n---\n正文\n')).toEqual({ name: '周报', description: '折行 成一段', instructions: '正文' });
    expect(() => parseSkillMarkdown('# 没有头')).toThrowError(expect.objectContaining({ code: 'SKILL_MARKDOWN_INVALID', details: { missing: ['frontmatter', 'name', 'description', '正文'] } }));
    expect(() => parseSkillMarkdown('---\ndescription: 只有描述\n---\n正文\n')).toThrowError(expect.objectContaining({ code: 'SKILL_MARKDOWN_INVALID', details: { missing: ['name'] } }));
    expect(() => parseSkillMarkdown('---\nname: 只有名称\n---\n正文\n')).toThrowError(expect.objectContaining({ code: 'SKILL_MARKDOWN_INVALID', details: { missing: ['description'] } }));
    expect(() => parseSkillMarkdown('---\nname: 周报\ndescription: 描述\n---\n\n')).toThrowError(expect.objectContaining({ code: 'SKILL_MARKDOWN_INVALID', details: { missing: ['正文'] } }));

    const name = stamp();
    const markdown = `---\nname: ${name}\ndescription: 导入描述\n---\n导入正文\n`;
    const imported = await importSkill({ markdown });
    ids.push(imported.id);
    expect(imported.origin).toBe('import');
    expect(imported.instructions).toBe('导入正文');
    expect(await prisma.skill.count({ where: { id: imported.id } })).toBe(1);
    const before = await prisma.skill.count();
    await expect(importSkill({ markdown })).rejects.toMatchObject({ code: 'SKILL_NAME_TAKEN', details: { skillId: imported.id, draft: { name, description: '导入描述', instructions: '导入正文' } } });
    expect(await prisma.skill.count()).toBe(before);
    expect(await prisma.skillVersion.count({ where: { skillId: imported.id } })).toBe(1);
    const covered = await importSkill({ markdown: `---\nname: ${name}\ndescription: 覆盖描述\n---\n覆盖正文\n`, resolution: 'version', expectedRevision: 1 });
    expect(covered.id).toBe(imported.id);
    expect(covered.revision).toBe(2);
    expect(covered.instructions).toBe('覆盖正文');
    expect((await prisma.skillVersion.findMany({ where: { skillId: imported.id }, orderBy: { revision: 'asc' } })).map((version) => version.reason)).toEqual(['导入 SKILL.md', '导入 SKILL.md 覆盖']);
    const renamed = await importSkill({ markdown, resolution: 'rename', name: `${name}-另存` });
    ids.push(renamed.id);
    expect(renamed.id).not.toBe(imported.id);
    expect(renamed.name).toBe(`${name}-另存`);
    expect(renamed.instructions).toBe('导入正文');
  });

  it('diffs lines with a stable longest-common-subsequence', () => {
    expect(diffLines('a\nb\nc', 'a\nx\nc')).toEqual([
      { type: 'same', text: 'a' },
      { type: 'remove', text: 'b' },
      { type: 'add', text: 'x' },
      { type: 'same', text: 'c' },
    ]);
    expect(diffLines('只剩一行', '只剩一行\n新增')).toEqual([{ type: 'same', text: '只剩一行' }, { type: 'add', text: '新增' }]);
  });
});
