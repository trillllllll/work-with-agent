import { randomUUID } from 'node:crypto';
import type { AgentNode } from '@prisma/client';
import { DomainError } from '../domain/task.js';
import { prisma } from '../infrastructure/prisma.js';
import { isOnline } from './orchestration/nodes.js';
import { directoryQuerySchema, directoryReplySchema, DIRECTORY_FEATURE, type DirectoryPage, type DirectoryTask } from '../node-agent/directory-protocol.js';

type Pending = {
  nodeId: string; tokenHash: string; task: DirectoryTask;
  resolve: (page: DirectoryPage) => void; reject: (error: Error) => void;
};
const pending = new Map<string, Pending>();

export function canBrowse(node: Pick<AgentNode, 'capabilitiesJson'>) {
  try { return JSON.parse(node.capabilitiesJson).directoryBrowser === DIRECTORY_FEATURE; } catch { return false; }
}

export function pendingDirectories(node: AgentNode) {
  return [...pending.values()].filter((item) => item.nodeId === node.id && item.tokenHash === node.tokenHash).map((item) => item.task);
}

export function reportDirectory(node: AgentNode, id: string, raw: unknown) {
  const item = pending.get(id);
  if (!item) return {};
  if (item.nodeId !== node.id || item.tokenHash !== node.tokenHash) throw new DomainError('HARNESS_NODE_SCOPE', '这台电脑没有会话权限', 403);
  const reply = directoryReplySchema.parse(raw);
  pending.delete(id);
  if ('page' in reply) item.resolve(reply.page);
  else item.reject(new DomainError('DIRECTORY_UNAVAILABLE', reply.error, 409));
  return {};
}

// Only the selected folder is persisted. Listing requests and replies expire in the relay.
async function requestDirectory(nodeId: string, path: string | null, inspectOnly: boolean) {
  const node = await prisma.agentNode.findFirst({ where: { id: nodeId, status: 'active', deletedAt: null } });
  if (!node || !isOnline(node)) throw new DomainError('HARNESS_OFFLINE', '这台电脑当前离线', 409);
  if (!canBrowse(node)) throw new DomainError('DIRECTORY_UNSUPPORTED', '请更新这台电脑上的执行器以浏览文件夹', 409);
  if (pendingDirectories(node).length >= 12) throw new DomainError('DIRECTORY_BUSY', '电脑正在处理目录请求，请稍后再试', 429);
  const id = randomUUID();
  const result = new Promise<DirectoryPage>((resolve, reject) => {
    pending.set(id, { task: { id, path, inspectOnly }, nodeId, tokenHash: node.tokenHash, resolve, reject });
  });
  const timer = setTimeout(() => pending.get(id)?.reject(new DomainError('DIRECTORY_TIMEOUT', '电脑未及时返回目录，请重试', 504)), 12_000);
  try { return { page: await result, tokenHash: node.tokenHash }; } finally { clearTimeout(timer); pending.delete(id); }
}

export async function browseDirectory(raw: unknown) {
  const { nodeId, path } = directoryQuerySchema.parse(raw);
  return (await requestDirectory(nodeId, path, false)).page;
}

export async function selectDirectory(raw: unknown) {
  const { nodeId, path } = directoryQuerySchema.parse(raw);
  if (!path) throw new DomainError('DIRECTORY_REQUIRED', '请选择一个项目文件夹', 400);
  const { page: { directory }, tokenHash } = await requestDirectory(nodeId, path, true);
  if (!directory) throw new DomainError('DIRECTORY_REQUIRED', '请选择一个项目文件夹', 400);
  return prisma.$transaction(async (tx) => {
    const node = await tx.agentNode.findFirst({ where: { id: nodeId, tokenHash, status: 'active', deletedAt: null } });
    if (!node) throw new DomainError('NODE_REVOKED', '电脑已断开', 409);
    const known = await tx.projectLocation.findFirst({
      where: { nodeId, path: { in: [directory.path, path] }, status: 'verified', project: { archivedAt: null } },
      include: { project: true }, orderBy: { id: 'asc' },
    });
    if (known) return { id: known.id, nodeId, path: directory.path, projectName: known.project.name, computerName: node.name };
    const saved = await tx.harnessDirectory.upsert({
      where: { nodeId_path: { nodeId, path: directory.path } }, create: { nodeId, path: directory.path, name: directory.name }, update: { name: directory.name },
    });
    return { id: saved.id, nodeId, path: saved.path, projectName: saved.name, computerName: node.name };
  });
}
