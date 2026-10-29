import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { TaskTextSaveBridge } from './task-text-save-bridge.js';
import { t } from '../i18n/index.js';
import { ApiError, API_URL, api, apiMutation, authHeaders } from './api.js';
import { enqueueWrite } from './todo.js';
import { normalizeApiBaseUrl, TaskDraftStore } from './task-draft-store.js';
import { NETWORK_WAIT_MS, TaskTextSyncCoordinator, type BranchLocks, type TransportOutcome, type TransportRequest } from './task-text-sync.js';
import type { TextVersion } from './task-editor-types.js';

let runtime: EditorRuntime | null = null;

export class EditorRuntime {
  readonly store = new TaskDraftStore();
  readonly coordinator: TaskTextSyncCoordinator;
  readonly scopeKey: string;
  readonly textSaves: TaskTextSaveBridge;

  constructor(scopeKey: string, client: QueryClient) {
    this.scopeKey = scopeKey;
    this.textSaves = new TaskTextSaveBridge(client, () => runtime === this && !sessionExpired);
    this.coordinator = new TaskTextSyncCoordinator({
      scopeKey,
      store: this.store,
      send: async (request) => {
        const outcome = await sendWithTimeout(request);
        if (outcome.kind === 'success') await this.textSaves.acknowledge(request, outcome.body);
        return outcome;
      },
      now: () => Date.now(),
      schedule: (fn, ms) => {
        const timer = window.setTimeout(fn, ms);
        return () => window.clearTimeout(timer);
      },
      enqueue: enqueueWrite,
      newRequestId: () => crypto.randomUUID(),
      fetchTaskText: fetchTaskText,
      isAuthed: () => runtime === this && !sessionExpired,
      locks: browserLocks(),
    });
  }

  static async open(actorId: string, client: QueryClient, workspaceId?: string, legacyDraftsImported = false) {
    const origin = window.location.origin;
    const apiBase = normalizeApiBaseUrl(import.meta.env.VITE_API_URL as string | undefined ?? '', origin);
    const scopeKey = JSON.stringify([origin, apiBase, actorId, ...(workspaceId ? [workspaceId] : [])]);
    if (workspaceId && legacyDraftsImported) await (runtime?.scopeKey === scopeKey ? runtime.store : new TaskDraftStore()).importLegacyScope(JSON.stringify([origin,apiBase,actorId]),scopeKey);
    if (runtime?.scopeKey === scopeKey) return runtime;
    runtime?.coordinator.dispose();
    const next = new EditorRuntime(scopeKey, client);
    runtime = next;
    return next;
  }

  static current() {
    return runtime;
  }
}

let sessionExpired = false;
/** Shared write guard for document sessions; matching a stale runtime alone is not authentication. */
export function isEditorRuntimeActive(scopeKey: string) {
  return runtime?.scopeKey === scopeKey && !sessionExpired;
}
export function markEditorSessionExpired(expired: boolean) {
  sessionExpired = expired;
  if (!expired) runtime?.coordinator.setAuthenticated(true);
}

/** 请求超时、断线、5xx 由协调器按同一 requestId 幂等重试。 */
async function sendWithTimeout(request: TransportRequest): Promise<TransportOutcome> {
  try {
    const body = await apiMutation(request.path, {
      method: request.method,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...authHeaders(), 'X-Request-ID': request.requestId },
      body: request.bodyJson,
      signal: AbortSignal.timeout(NETWORK_WAIT_MS),
    });
    {
      // 资料引用命令的结果数组归一成与 PATCH 相同的任务形状。
      if (request.path === '/api/v1/commands') {
        const data = (body as { data?: { results?: unknown[]; status?: string } } | null)?.data;
        if (data?.status === 'pending_approval') return { kind: 'rejected', status: 409, code: 'REFERENCE_PENDING', body };
        return { kind: 'success', status: 200, body: { data: Array.isArray(data?.results) ? data?.results[0] : data } };
      }
      return { kind: 'success', status: 200, body };
    }
  } catch (error) {
    if (error instanceof ApiError && error.status) return { kind: 'rejected', status: error.status, code: error.code, body: { code: error.code, error: error.message, details: error.details } };
    return { kind: 'network' };
  }
}

async function fetchTaskText(taskId: string): Promise<TextVersion | null> {
  try {
    const task = await api<{ revision?: number; title?: string; description?: string }>(`/api/tasks/${taskId}?includeArchived=true`);
    return {
      revision: typeof task.revision === 'number' ? task.revision : 0,
      title: task.title ?? '',
      description: task.description ?? '',
    };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/** Web Locks 持有分支所有权；不可用的环境回退为新分支 + 显式恢复。 */
const heldLocks: Array<{ name: string; release: () => void }> = [];

function browserLocks(): BranchLocks | undefined {
  if (typeof navigator === 'undefined' || !navigator.locks?.request) return undefined;
  return {
    tryHold: (name) => new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (value: boolean) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      navigator.locks.request(name, { ifAvailable: true }, (lock) => {
        if (!lock) {
          settle(false);
          return;
        }
        // 已取得：立即上报，并在后台一直持有直到页面关闭。
        settle(true);
        return new Promise<void>((holdReleased) => {
          heldLocks.push({ name, release: () => holdReleased() });
        });
      }).catch(() => settle(false));
    }),
  };
}

const RuntimeContext = createContext<EditorRuntime | null>(null);

export function TaskEditorRuntimeProvider({ runtime, children }: { runtime: EditorRuntime | null; children: ReactNode }) {
  return <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>;
}

export function useEditorRuntime() {
  return useContext(RuntimeContext);
}

/** 会话级上传状态：详情关闭后上传仍继续，插入只作用于捕获的任务编辑器。 */
export type TaskUpload = {
  taskId: string;
  uploadId: string;
  fileName: string;
  file: File;
  state: 'compressing' | 'uploading' | 'done' | 'failed' | 'cancelled';
  url?: string;
  error?: string;
};

const uploads = new Map<string, TaskUpload>();
const uploadListeners = new Set<() => void>();

export function subscribeUploads(listener: () => void) {
  uploadListeners.add(listener);
  return () => uploadListeners.delete(listener);
}

export function listUploads() {
  return [...uploads.values()];
}

function notifyUploads() {
  for (const listener of uploadListeners) listener();
}

export function enqueueTaskUpload(taskId: string, file: File) {
  const uploadId = crypto.randomUUID();
  uploads.set(uploadId, { taskId, uploadId, fileName: file.name || t('app:taskImage.fallbackName'), file, state: 'compressing' });
  notifyUploads();
  return uploadId;
}

export function markUpload(uploadId: string, patch: Partial<TaskUpload>) {
  const entry = uploads.get(uploadId);
  if (!entry) return;
  Object.assign(entry, patch);
  if (entry.state === 'done' || entry.state === 'cancelled') uploads.delete(uploadId);
  notifyUploads();
}

export function cancelUpload(uploadId: string) {
  markUpload(uploadId, { state: 'cancelled' });
}

export function uploadImageUrl(taskId: string, imageId: string) {
  return `/api/tasks/${taskId}/images/${imageId}`;
}

/** 上传一张图片：压缩后 POST，返回服务端 URL；失败抛错。 */
export async function runTaskUpload(taskId: string, uploadId: string, file: File) {
  const { compressTaskImage, fileToBase64 } = await import('./task-image.js');
  const compressed = await compressTaskImage(file);
  markUpload(uploadId, { state: 'uploading' });
  const attachmentBase64 = await fileToBase64(compressed.file);
  const saved = await apiMutation<{ url: string }>(`/api/tasks/${taskId}/images`, { method: 'POST', body: JSON.stringify({ attachmentBase64, mimeType: compressed.mimeType }) });
  const url = saved.data?.url;
  if (!url) throw new ApiError(t('app:taskImage.uploadFailed'));
  markUpload(uploadId, { state: 'done', url });
  return url;
}

/** beforeunload 保护范围：未持久化文字与未完成上传。 */
export function beforeunloadGuard(event: BeforeUnloadEvent) {
  const coordinator = EditorRuntime.current()?.coordinator;
  if (coordinator?.hasUnpersistedWork() || [...uploads.values()].some((upload) => upload.state === 'compressing' || upload.state === 'uploading')) {
    event.preventDefault();
  }
}

export function useBeforeunloadGuard() {
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current) return;
    mounted.current = true;
    window.addEventListener('beforeunload', beforeunloadGuard);
    return () => {
      mounted.current = false;
      window.removeEventListener('beforeunload', beforeunloadGuard);
    };
  }, []);
}
