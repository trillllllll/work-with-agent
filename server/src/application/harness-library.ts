import { randomUUID } from 'node:crypto';
import type { AgentNode } from '@prisma/client';
import type { z } from 'zod';
import { DomainError } from '../domain/task.js';
import { isOnline } from './orchestration/nodes.js';
import {
  HARNESS_FEATURE, HARNESS_LIBRARY_FEATURE, HARNESS_LIBRARY_READS, HARNESS_WORKSPACE_FEATURE, harnessKind,
  harnessReadTaskSchema, harnessReadResultSchemas, harnessReadErrorSchema,
  type HarnessKind, type HarnessReadTask, type HarnessCatalogPage, type HarnessCatalogThread, type HarnessFilesPage, type HarnessHistoryPage,
} from '../node-agent/harness-protocol.js';

type Results = { index: z.infer<typeof harnessReadResultSchemas.index>; files: HarnessFilesPage; catalog: HarnessCatalogPage; thread: HarnessCatalogThread; history: HarnessHistoryPage };
type Request<K extends keyof Results> = Omit<Extract<HarnessReadTask, { kind: K }>, 'id' | 'kind'>;
type Pending = {
  nodeId: string; tokenHash: string; task: HarnessReadTask;
  resolve: (result: Results[keyof Results]) => void; reject: (error: Error) => void;
};
const pending = new Map<string, Pending>();

export function supportsHarnessLibrary(node: Pick<AgentNode, 'capabilitiesJson'>) {
  try { return JSON.parse(node.capabilitiesJson).harnessLibrary === HARNESS_LIBRARY_FEATURE; } catch { return false; }
}
export function supportsHarnessWorkspace(node: Pick<AgentNode, 'capabilitiesJson'>) {
  try { return JSON.parse(node.capabilitiesJson).harnessWorkspace === HARNESS_WORKSPACE_FEATURE; } catch { return false; }
}
export function nodeHarnesses(node: Pick<AgentNode, 'capabilitiesJson'>): HarnessKind[] {
  try {
    const capabilities = JSON.parse(node.capabilitiesJson);
    if (capabilities.harnessSessions !== HARNESS_FEATURE) return [];
    if (capabilities.harnessWorkspace === HARNESS_WORKSPACE_FEATURE && Array.isArray(capabilities.harnessKinds)) {
      return capabilities.harnessKinds.flatMap((item: unknown) => {
        const parsed = harnessKind.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      });
    }
    return ['codex'];
  } catch { return []; }
}

export function pendingHarnessReads(node: AgentNode) {
  return [...pending.values()].filter((item) => item.nodeId === node.id && item.tokenHash === node.tokenHash).map((item) => item.task);
}

export function reportHarnessRead(node: AgentNode, id: string, raw: unknown) {
  const item = pending.get(id);
  if (!item) return {};
  if (item.nodeId !== node.id || item.tokenHash !== node.tokenHash) throw new DomainError('HARNESS_NODE_SCOPE', '这台电脑没有会话权限', 403);
  const error = harnessReadErrorSchema.safeParse(raw);
  if (error.success) item.reject(new DomainError('HARNESS_READ_UNAVAILABLE', error.data.error, 409));
  else item.resolve(harnessReadResultSchemas[item.task.kind].parse(raw));
  pending.delete(id);
  return {};
}

export async function requestHarnessRead<K extends keyof Results>(node: AgentNode | null, kind: K, input: Request<K>): Promise<Results[K]> {
  if (!node || !isOnline(node) || node.status !== 'active' || node.deletedAt) throw new DomainError('HARNESS_OFFLINE', '这台电脑当前离线', 409);
  if (!supportsHarnessLibrary(node)) throw new DomainError('HARNESS_LIBRARY_UNSUPPORTED', '请更新这台电脑的执行器以读取 Codex 历史', 409);
  if ((kind === 'index' || kind === 'files') && !supportsHarnessWorkspace(node)) {
    throw new DomainError('HARNESS_LIBRARY_UNSUPPORTED', '请更新这台电脑的执行器以使用项目会话工具', 409);
  }
  if (pendingHarnessReads(node).length >= HARNESS_LIBRARY_READS) throw new DomainError('HARNESS_READ_BUSY', '电脑正在读取对话，请稍后重试', 429);
  const id = randomUUID();
  const task = harnessReadTaskSchema.parse({ ...input, id, kind });
  const result = new Promise<Results[keyof Results]>((resolve, reject) => pending.set(id, { nodeId: node.id, tokenHash: node.tokenHash, task, resolve, reject }));
  const timer = setTimeout(() => pending.get(id)?.reject(new DomainError('HARNESS_READ_TIMEOUT', '电脑未及时返回对话，请重试', 504)), 22_000);
  try { return await result as Results[K]; } finally { clearTimeout(timer); pending.delete(id); }
}
