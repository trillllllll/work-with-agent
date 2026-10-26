import { describe, expect, it, vi } from 'vitest';
import { prisma } from './infrastructure/prisma.js';
import { readPageState } from './agent/app-knowledge.js';
import { contextFromRequest } from './agent/chat-context.js';
import { AgentService } from './agent.js';

describe('assistant identity context boundaries', () => {
  it('reads only the learning domain when study is opened on a work page', async () => {
    const changes = vi.spyOn(prisma.changeRecord, 'findMany');
    const maps = vi.spyOn(prisma.learningMap, 'findMany').mockResolvedValue([]);
    const nodes = vi.spyOn(prisma.learningNode, 'groupBy').mockResolvedValue([] as never);
    try {
      const context = contextFromRequest({ pageContext: { page: 'changes', topicId: 'work-topic' } });
      context.identityId = 'study';
      context.selectedTaskIds = ['work-task'];
      const state = await readPageState(context);
      expect(state).toMatchObject({ page: 'learning', scope: { kind: 'all' }, taskFilter: null, selectedTaskIds: [], learningMaps: [] });
      expect(changes).not.toHaveBeenCalled();
      expect(maps).toHaveBeenCalledOnce();
    } finally { changes.mockRestore(); maps.mockRestore(); nodes.mockRestore(); }
  });

  it('returns the authoritative conversation identity in a snapshot', async () => {
    const conversation = await prisma.conversation.create({ data: { identityId: 'study' } });
    try {
      expect(await new AgentService().snapshot(conversation.id)).toMatchObject({ identityId: 'study', messages: [] });
    } finally { await prisma.conversation.delete({ where: { id: conversation.id } }); }
  });
});
