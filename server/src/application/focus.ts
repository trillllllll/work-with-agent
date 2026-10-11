import { prisma, notFound, now } from './workspace-store.js';
import { focusSessionCreateSchema, focusSessionListSchema } from './workspace-input.js';

export class FocusService {
  async list(options: unknown = {}) {
    const query = focusSessionListSchema.parse(options);
    return prisma.focusSession.findMany({
      where: {
        ...(query.taskId ? { taskId: query.taskId } : {}),
        ...(query.from || query.to ? { startedAt: { ...(query.from ? { gte: `${query.from}T00:00` } : {}), ...(query.to ? { lte: `${query.to}T23:59` } : {}) } } : {}),
      },
      orderBy: { startedAt: 'desc' },
      take: query.limit ?? 100,
    });
  }
  async create(value: unknown) {
    const input = focusSessionCreateSchema.parse(value);
    if (input.taskId) {
      const task = await prisma.task.findFirst({ where: { id: input.taskId, deletedAt: null } });
      if (!task) throw notFound('任务不存在');
    }
    const session = await prisma.focusSession.create({
      data: { ...input, taskId: input.taskId ?? null, createdAt: now() },
    });
    return session;
  }
}
