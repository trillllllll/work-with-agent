import { Brain, Library, Plug, Sparkles, User, Workflow } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { proposalSource, sourceGroupKey } from './proposal-source.js';

const connections = [{ id: 'conn-1', name: '笔记本上的 Claude Code' }];

describe('proposal source', () => {
  it('maps known actors and resolves a connection name', () => {
    expect(proposalSource('connection:conn-1', { connections })).toMatchObject({ key: 'connection', label: '笔记本上的 Claude Code', icon: Plug });
    expect(proposalSource('connection:stale-suffix', { connectionId: 'conn-1', connections })).toMatchObject({ label: '笔记本上的 Claude Code' });
    expect(proposalSource('connection:missing', { connections })).toMatchObject({ key: 'deletedConnection', label: '已删除的连接', icon: Plug });
    expect(proposalSource('connection:conn-1').label).toBe('连接');
    expect(proposalSource('auto-memory:job-1')).toMatchObject({ key: 'autoMemory', label: '自动记忆', icon: Brain });
    expect(proposalSource('auto-memory-archive')).toMatchObject({ key: 'autoMemoryArchive', label: '自动记忆归档', icon: Brain });
    expect(proposalSource('organization:org-1')).toMatchObject({ key: 'organization', label: '知识整理', icon: Library });
    expect(proposalSource('orchestration-learning')).toMatchObject({ key: 'learning', label: '派发学习', icon: Workflow });
    expect(proposalSource('builtin-agent')).toMatchObject({ key: 'assistant', label: 'AI 助手', icon: Sparkles });
    expect(proposalSource('local-owner')).toMatchObject({ key: 'owner', label: '本机用户', icon: User });
    expect(proposalSource('custom-actor')).toEqual({ key: 'raw', label: 'custom-actor', icon: null });
  });

  it('groups every connection separately and collapses prefixed actors', () => {
    expect(sourceGroupKey('connection:abc', 'real')).toBe('connection:real');
    expect(sourceGroupKey('auto-memory:one')).toBe(sourceGroupKey('auto-memory:two'));
    expect(sourceGroupKey('orchestration-learning')).toBe('learning');
  });
});
