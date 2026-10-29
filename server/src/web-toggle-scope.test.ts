import { describe, expect, it } from 'vitest';
import { isGroupAllowedFor, scopeGroupsFor, toolsForGroups } from './agent/tool-loading.js';

// 会话级联网开关：用户显式开启时 web 组可越过身份白名单，仅此一个组。
describe('会话级联网开关（webEnabled 越过身份白名单）', () => {
  it('工作助手默认没有 web 组', () => {
    expect(isGroupAllowedFor('work', 'web')).toBe(false);
    expect(scopeGroupsFor('work', ['tasks', 'web'])).toEqual(['tasks']);
  });

  it('webEnabled 时工作助手保留 web 组', () => {
    expect(scopeGroupsFor('work', ['tasks', 'web'], true)).toEqual(['tasks', 'web']);
  });

  it('webEnabled 只放行 web，其他身份外的组仍被剔除', () => {
    expect(scopeGroupsFor('work', ['web', 'learning'], true)).toEqual(['web']);
    expect(scopeGroupsFor('work', ['web', 'learning_write'], true)).toEqual(['web']);
  });

  it('webEnabled 时工作助手能拿到 web_search / read_webpage 工具', () => {
    const names = toolsForGroups(['web'], false, 'work', true).map((tool) => tool.function.name);
    expect(names).toContain('web_search');
    expect(names).toContain('read_webpage');
  });

  it('开关关闭时行为与原来一致，学习助手不受影响', () => {
    expect(toolsForGroups(['web'], false, 'work').map((tool) => tool.function.name)).not.toContain('web_search');
    expect(scopeGroupsFor('study', ['learning', 'web'])).toEqual(['learning', 'web']);
  });
});
