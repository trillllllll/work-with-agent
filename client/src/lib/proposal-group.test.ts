import { describe, expect, it } from 'vitest';
import { analyzeProposal, groupNote } from './proposal-group.js';

const parent = 'parent-entity';
const groupCommands = [
  { kind: 'task.create', entityId: parent, input: { title: '售后知识库迁移', priority: 'medium', topicId: 'topic-1' } },
  { kind: 'task.create', entityId: 'child-a', input: { title: '导出旧 FAQ', parentId: parent, topicId: 'topic-1' } },
  { kind: 'task.create', entityId: 'child-b', input: { title: '按产品线重新分类', parentId: parent, topicId: 'topic-1' } },
  { kind: 'task.update', targetId: 'task-4', expectedRevision: 1, input: { status: 'doing' } },
];
const groupPreview = [
  { detail: { affectedTasks: [{ id: 't1', title: '甲', revision: 1 }, { id: 't2', title: '乙', revision: 2 }] } },
  { detail: { affectedTasks: [{ id: 't1', title: '甲', revision: 1 }] } },
  { detail: { affectedTasks: [{ id: 't2', title: '乙', revision: 9 }] } },
  { detail: { before: { title: '整理退货工单模板', revision: 1, status: 'todo' }, affectedTasks: [{ id: 'task-4', title: '整理退货工单模板', revision: 1 }] } },
];

describe('proposal groups', () => {
  it('numbers parent and child items and dedupes affected tasks', () => {
    const analysis = analyzeProposal(groupCommands, groupPreview);
    expect(analysis.items.map((item) => item.index)).toEqual([1, 2, 3, 4]);
    expect(analysis.items[1].parentIndex).toBe(1);
    expect(analysis.items[2].parentIndex).toBe(1);
    expect(analysis.items[1].dependsOn).toEqual([1]);
    expect(analysis.items[3].parentIndex).toBeNull();
    expect(analysis.affectedTasks.map((task) => task.id)).toEqual(['t1', 't2', 'task-4']);
    expect(analysis.needsGroupNote).toBe(true);
    expect(analysis.title).toBe('一组 4 项任务修改');
    expect(analysis.confirmKey).toBe('confirm.group');
    expect(analysis.confirmLabel).toBe('确认这一组（4 项）');
    const note = groupNote(analysis, 'Claude Code');
    expect(note).toBe('这 4 项是 Claude Code 一次提交的，第 2、3 项是第 1 项的子任务，要等它建好才能挂上去，所以只能整组确认或整组拒绝。');
    expect(note).not.toContain('删除');
    expect(note).not.toContain('重新预览');
  });

  it('uses the single-item confirm label and a memory or skill title', () => {
    const memory = analyzeProposal(
      [{ kind: 'memory.create', input: { title: '待确认的问题', content: '正文', reason: '因为', topicId: null } }],
      [{ detail: { title: '待确认的问题', evidenceSummaries: [] } }],
    );
    expect(memory.confirmKey).toBe('confirm.single');
    expect(memory.confirmLabel).toBe('确认');
    expect(memory.title).toBe('保存记忆');
    expect(memory.needsGroupNote).toBe(false);
    expect(groupNote(memory, '自动记忆')).toBe('');

    const task = analyzeProposal(
      [{ kind: 'task.update', targetId: 'task-1', input: { title: '新标题', priority: 'high' } }],
      [{ detail: { before: { title: '待确认页排版优化', revision: 1 }, affectedTasks: [{ id: 'task-1', title: '待确认页排版优化', revision: 1 }] } }],
    );
    expect(task.title).toBe('修改任务「待确认页排版优化」');
    expect(task.confirmLabel).toBe('确认');

    const skill = analyzeProposal(
      [{ kind: 'skill.create', input: { name: 'dispatch-checklist', description: '说明', instructions: '步骤', reason: '第三次' } }],
      [{ detail: { kind: 'skill.create', name: 'dispatch-checklist' } }],
    );
    expect(skill.title).toBe('新建技能「dispatch-checklist」');
    expect(skill.type).toBe('skill');
  });
});
