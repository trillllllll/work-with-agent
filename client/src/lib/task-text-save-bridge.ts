import type { QueryClient } from '@tanstack/react-query';
import type { Task } from './api.js';
import type { TransportRequest } from './task-text-sync.js';
import { keepNewestTask, queryKeys } from './todo.js';

/** Per authenticated editor scope: only acknowledged, text-only local writes can advance a stale list action. */
export class TaskTextSaveBridge {
  private readonly versions = new Map<string, Map<number, number>>();

  constructor(private readonly client: QueryClient, private readonly active: () => boolean) {}

  advance(taskId: string, revision: number): number {
    if (!this.active()) return revision;
    const versions = this.versions.get(taskId);
    while (versions?.has(revision)) revision = versions.get(revision)!;
    return revision;
  }

  async acknowledge(request: TransportRequest, body: unknown): Promise<void> {
    if (!this.active() || request.method !== 'PATCH') return;
    const match = request.path.match(/^\/api\/tasks\/([^/]+)$/);
    if (!match || !body || typeof body !== 'object') return;
    const sent = JSON.parse(request.bodyJson) as Record<string, unknown>;
    // Never treat metadata writes, remote refreshes or rejected requests as text-save receipts.
    if (!Object.keys(sent).every(key => ['expectedRevision', 'title', 'description'].includes(key))) return;
    if (sent.title === undefined && sent.description === undefined) return;
    const saved = (body as { data?: Task }).data;
    if (!saved || saved.id !== match[1] || typeof sent.expectedRevision !== 'number' || !Number.isInteger(sent.expectedRevision)
      || sent.expectedRevision < 1 || saved.revision !== sent.expectedRevision + 1 || typeof saved.title !== 'string' || typeof saved.status !== 'string') return;

    await Promise.all([this.client.cancelQueries({ queryKey: queryKeys.task(saved.id) }), this.client.cancelQueries({ queryKey: queryKeys.tasks })]);
    if (!this.active()) return;
    const versions = this.versions.get(saved.id) ?? new Map<number, number>();
    versions.set(sent.expectedRevision, saved.revision);
    this.versions.set(saved.id, versions);
    const merge = (old: Task | undefined) => keepNewestTask(old, { ...old, ...saved });
    this.client.setQueryData<Task>(queryKeys.task(saved.id), merge);
    this.client.setQueriesData<Task[]>({ queryKey: queryKeys.tasks }, old => Array.isArray(old) ? old.map(item => item.id === saved.id ? merge(item) : item) : old);
  }
}
