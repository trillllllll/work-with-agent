import { registerCommandHandler } from '../commands.js';
import { jsonSchema } from '../command-catalog.js';
import { ownerActor } from '../security.js';
import { recordChange } from '../workspace-store.js';
import { configSchema } from './input.js';
import { generatePracticeInTransaction } from './service.js';
import { requireMap, fail } from './store.js';
export function registerPracticeCommands() {
  registerCommandHandler('learning.practice.request', {
    forceProposal: true, description: '生成限定范围的正式练习候选；用户确认后开始出题，题目仍需采用后开始练习。', inputSchema: jsonSchema(configSchema),
    inspect: async (tx, _actor, command) => {
      const config = configSchema.parse(command.input);
      const map = await requireMap(tx, config.mapId);
      const nodes = await tx.learningNode.findMany({ where: { mapId: map.id, deletedAt: null }, select: { id: true, title: true, kind: true, parentId: true, revision: true } });
      if (config.nodeIds?.some(id => !nodes.some(n => n.id === id)))
        fail('NOT_FOUND', '练习范围中有不可用知识点', 404);
      return { preconditions: { mapId: map.id, mapRevision: map.revision, nodes: nodes.map(n => ({ id: n.id, revision: n.revision })) }, preview: { title: map.title, scope: config.nodeIds?.map(id => nodes.find(n => n.id === id)!.title) ?? '整个主题', count: config.count, types: config.types, difficulty: config.difficulty, mode: config.mode, goal: config.goal } };
    },
    execute: async (tx, actor, command, context) => {
      if (actor.kind !== 'user' && !context.proposalId && !context.preview)
        fail('OWNER_REQUIRED', '正式出题需要用户确认', 403);
      const config = configSchema.parse(command.input);
      const map = await requireMap(tx, config.mapId);
      const scopeNodes = await tx.learningNode.findMany({ where: { mapId: map.id, deletedAt: null, ...(config.nodeIds ? { id: { in: config.nodeIds } } : { kind: 'item' }) }, select: { title: true } });
      const result = await generatePracticeInTransaction(tx, config, ownerActor.id);
      // Audit only the public projection. Candidate solutions remain worker-private.
      await recordChange(tx, 'learning_practice_job', result.job.id, 'create', null, { id: result.job.id, title: map.title, ...config, scope: scopeNodes.map(n => n.title), state: result.job.state }, context);
      return { jobId: result.job.id, job: result.job };
    },
  });
}
