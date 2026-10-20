import { describe, expect, it } from 'vitest';
import { editableFieldsFor, formatFieldValue, inputSummaryText, isEditableField } from './proposal-fields.js';

describe('proposal field formatting', () => {
  it('does not render evidence object arrays or label lists as [object Object]', () => {
    const evidence = [{ type: 'task', id: '1c0e', revision: 2, title: '附件能力' }];
    const labels = ['MCP', 'WWA', '图片附件'];
    expect(formatFieldValue('evidence', evidence)).toEqual({ kind: 'omit' });
    expect(formatFieldValue('labels', labels)).toEqual({ kind: 'list', items: labels });
    const summary = inputSummaryText({ evidence, labels, priority: 'medium', kind: 'question', nested: { id: 'secret-object' } });
    expect(summary).not.toContain('[object Object]');
    expect(summary).not.toContain('1c0e');
    expect(summary).not.toContain('secret-object');
    expect(summary).toContain('MCP');
    expect(summary).toContain('WWA');
    expect(summary).toContain('中');
  });

  it('translates priority and status and localizes a calendar date', () => {
    expect(formatFieldValue('priority', 'high')).toEqual({ kind: 'text', text: '高' });
    expect(formatFieldValue('status', 'doing')).toEqual({ kind: 'text', text: '进行中' });
    const date = formatFieldValue('dueDate', '2026-10-24');
    expect(date.kind).toBe('text');
    if (date.kind === 'text') {
      expect(date.text).not.toContain('[object Object]');
      expect(date.text).toContain('24');
    }
  });

  it('keeps only the fields each command family is allowed to edit', () => {
    expect(editableFieldsFor('task.update')).toEqual(['title', 'description', 'priority', 'status', 'dueDate']);
    expect(isEditableField('task.update', 'tagIds')).toBe(false);
    expect(editableFieldsFor('memory.create')).toEqual(['title', 'content', 'reason']);
    expect(isEditableField('memory.update', 'evidence')).toBe(false);
    expect(editableFieldsFor('skill.create')).toEqual(['description', 'instructions', 'reason']);
    expect(isEditableField('skill.update', 'name')).toBe(false);
    expect(editableFieldsFor('topic.update')).toEqual([]);
  });
});
