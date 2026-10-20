import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { ApiError, api, authHeaders } from '@/lib/api.js';
import { submitCommands, type Command } from '@/lib/platform.js';
import { t } from '../../i18n/index.js';
import type { MaterialSummary } from './types.js';

export type UploadStatus = 'queued' | 'uploading' | 'duplicate' | 'creating' | 'done' | 'failed' | 'skipped' | 'cancelled';

export type UploadTarget = {
  topicId: string | null;
  folderId: string | null;
  taskIds: string[];
  replaceMaterialId?: string;
  expectedRevision?: number;
  silent?: boolean;
};

export type UploadRecord = {
  localId: string;
  requestKey: string;
  file: File;
  relativePath: string;
  name: string;
  status: UploadStatus;
  progress: number | null;
  error?: string;
  uploadId?: string;
  duplicates?: MaterialSummary[];
  batchId: string;
  target: UploadTarget;
  folderId?: string | null;
  cancelRequested?: boolean;
  action?: 'create' | 'reuse';
  reuseMaterialId?: string;
};

type DirectoryReader = { readEntries: (success: (entries: FileSystemEntry[]) => void, failure: (error: DOMException) => void) => void };
type ReadyUpload = { id: string; state?: string; duplicates?: MaterialSummary[] };
type OpenedUpload = { id: string; state?: string; materialId?: string | null };
type ServerUpload = { id: string; state?: string; materialId?: string | null };
type Batch = { pending: number; added: number; failed: number; toasted: boolean; silent: boolean; resolve: () => void };

const poolLimit = 3;
let active = 0;
let records: UploadRecord[] = [];
const listeners = new Set<() => void>();
const changed = new Set<() => void>();
const batches = new Map<string, Batch>();
const settled = new Set<string>();
const xhrs = new Map<string, XMLHttpRequest>();

function emit() {
  records = records.slice();
  listeners.forEach((listener) => listener());
}

function update(localId: string, patch: Partial<UploadRecord>) {
  records = records.map((item) => item.localId === localId ? { ...item, ...patch } : item);
  emit();
}

function current(localId: string) {
  return records.find((item) => item.localId === localId);
}

function cancelled(localId: string) {
  const record = current(localId);
  return !record || record.cancelRequested || record.status === 'cancelled';
}

export function subscribeUploads(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getUploads() {
  return records;
}

export function useUploads() {
  return useSyncExternalStore(subscribeUploads, getUploads, getUploads);
}

export function onLibraryChanged(listener: () => void) {
  changed.add(listener);
  return () => changed.delete(listener);
}

function notifyChanged() {
  changed.forEach((listener) => listener());
}

export function assertRelativePath(path: string) {
  if (!path || path.includes('\0')) throw new Error(t('library:upload.invalidPath'));
  if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(path)) throw new Error(t('library:upload.invalidPath'));
  const parts = path.split(/[\\/]/);
  if (parts.some((part) => part === '' || part === '.' || part === '..')) throw new Error(t('library:upload.invalidPath'));
  return parts.join('/');
}

function fileOf(entry: FileSystemEntry) {
  return new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
}

async function readDirectory(entry: FileSystemEntry) {
  const reader = (entry as FileSystemDirectoryEntry & { createReader: () => DirectoryReader }).createReader();
  const all: FileSystemEntry[] = [];
  while (true) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    all.push(...batch);
  }
  return all.sort((left, right) => left.name.localeCompare(right.name));
}

async function walkEntry(entry: FileSystemEntry, prefix: string): Promise<Array<{ file: File; relativePath: string }>> {
  const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    const file = await fileOf(entry);
    return [{ file, relativePath: assertRelativePath(relativePath) }];
  }
  if (!entry.isDirectory) return [];
  assertRelativePath(relativePath);
  const children = await readDirectory(entry);
  const nested = await Promise.all(children.map((child) => walkEntry(child, relativePath)));
  return nested.flat();
}

export async function filesFromList(list: FileList | File[]) {
  return [...list].map((file) => ({ file, relativePath: assertRelativePath(file.webkitRelativePath || file.name) })).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export async function filesFromTransfer(transfer: DataTransfer) {
  const items = [...transfer.items];
  const entries = items.flatMap((item) => {
    const entry = item.webkitGetAsEntry?.() ?? null;
    return entry ? [entry] : [];
  });
  if (!entries.length) return filesFromList(transfer.files);
  const groups = await Promise.all(entries.map((entry) => walkEntry(entry, '')));
  return groups.flat().sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function putBytes(id: string, file: File, localId: string, onProgress: (value: number | null) => void) {
  return new Promise<ReadyUpload>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhrs.set(localId, xhr);
    xhr.open('PUT', `/api/v1/library/uploads/${encodeURIComponent(id)}/content`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    for (const [key, value] of Object.entries(authHeaders())) xhr.setRequestHeader(key, value);
    xhr.upload.onprogress = (event) => onProgress(event.lengthComputable && event.total > 0 ? event.loaded / event.total : null);
    xhr.onabort = () => { xhrs.delete(localId); reject(new DOMException(t('library:upload.cancelled'), 'AbortError')); };
    xhr.onerror = () => { xhrs.delete(localId); reject(new Error(t('library:upload.failed'))); };
    xhr.onload = () => {
      xhrs.delete(localId);
      let body: { data?: ReadyUpload; error?: string | { message?: string } } = {};
      try { body = JSON.parse(xhr.responseText) as typeof body; } catch { /* The status still decides success. */ }
      if (xhr.status >= 200 && xhr.status < 300 && body.data) resolve(body.data);
      else reject(new Error(typeof body.error === 'string' ? body.error : body.error?.message || t('library:upload.failed')));
    };
    xhr.send(file);
  });
}

async function deleteUpload(id: string) {
  try {
    await fetch(`/api/v1/library/uploads/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'include', headers: authHeaders() });
  } catch { /* The queue still leaves the cancelled state. */ }
}

function folderLabel(value: string) {
  const name = value.normalize('NFKC').trim().replace(/[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/gu, ' ');
  const length = Array.from(name).length;
  if (length < 1 || length > 80) throw new Error(t('library:upload.folderNameLength'));
  return name;
}

const folderIds = new Map<string, string>();
let folderChain: Promise<void> = Promise.resolve();

function lockFolders<T>(work: () => Promise<T>) {
  const run = folderChain.then(work, work);
  folderChain = run.then(() => undefined, () => undefined);
  return run;
}

async function rememberFolders() {
  const listed = await api<{ items: Array<{ id: string; parentId: string | null; name: string }> }>('/api/v1/library/folders');
  folderIds.clear();
  for (const folder of listed.items) folderIds.set(`${folder.parentId ?? ''}\n${folder.name.toLowerCase()}`, folder.id);
}

async function ensureFolder(parentId: string | null, rawName: string) {
  const name = folderLabel(rawName);
  const key = `${parentId ?? ''}\n${name.toLowerCase()}`;
  const cached = folderIds.get(key);
  if (cached) return cached;
  const created = await submitCommands([{ kind: 'libraryFolder.create', input: { parentId, name } }], crypto.randomUUID());
  const id = created.results?.[0]?.id as string | undefined;
  if (!id) throw new Error(t('library:upload.folderNotCreated'));
  folderIds.set(key, id);
  return id;
}

export async function folderForPath(relativePath: string, root: string | null) {
  const parts = relativePath.split('/').slice(0, -1);
  return lockFolders(async () => {
    await rememberFolders();
    let parent = root;
    for (const part of parts) parent = await ensureFolder(parent, part);
    return parent;
  });
}

function commitRequestId(record: UploadRecord) {
  return `library-commit:${record.requestKey}:${record.action ?? 'create'}:${record.reuseMaterialId ?? ''}:${record.target.replaceMaterialId ?? ''}`;
}

async function sendCommit(record: UploadRecord) {
  const requestId = commitRequestId(record);
  if (record.target.replaceMaterialId) {
    await submitCommands([{
      kind: 'material.replace',
      targetId: record.target.replaceMaterialId,
      expectedRevision: record.target.expectedRevision,
      input: { uploadId: record.uploadId },
    }], requestId);
    return;
  }
  await submitCommands([{
    kind: 'material.create',
    input: {
      uploadId: record.uploadId,
      duplicateAction: record.action ?? 'create',
      ...(record.reuseMaterialId ? { reuseMaterialId: record.reuseMaterialId } : {}),
      topicId: record.target.topicId,
      folderId: record.folderId ?? null,
      taskIds: record.target.taskIds,
    },
  }], requestId);
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function readUpload(id: string) {
  return api<ServerUpload>(`/api/v1/library/uploads/${encodeURIComponent(id)}`);
}

function finishItem(record: UploadRecord, status: 'done' | 'failed' | 'skipped' | 'cancelled', error?: string) {
  if (settled.has(record.localId)) return;
  settled.add(record.localId);
  const progress = status === 'done' ? 1 : record.progress;
  update(record.localId, { status, error, progress, cancelRequested: status === 'cancelled' ? true : record.cancelRequested });
  const batch = batches.get(record.batchId);
  if (!batch) return;
  batch.pending -= 1;
  if (status === 'done') batch.added += 1;
  if (status === 'failed') batch.failed += 1;
  if (batch.pending === 0 && !batch.toasted) {
    batch.toasted = true;
    if (!batch.silent) toast.success(t('library:upload.added', { count: batch.added, failed: batch.failed }));
    if (batch.added) notifyChanged();
    batch.resolve();
  }
}

async function commitWithRecovery(record: UploadRecord) {
  const localId = record.localId;
  const retryReady = async (uploadId: string) => {
    const latest = current(localId) ?? record;
    await sendCommit({ ...latest, uploadId });
    finishItem(current(localId) ?? latest, 'done');
  };
  const reupload = async (uploadId: string) => {
    const latest = current(localId) ?? record;
    await putBytes(uploadId, latest.file, localId, (progress) => update(localId, { progress }));
    await sendCommit({ ...latest, uploadId, folderId: latest.folderId });
    finishItem(current(localId) ?? latest, 'done');
  };
  try {
    if (cancelled(localId)) {
      finishItem(current(localId) ?? record, 'cancelled');
      return;
    }
    await sendCommit(current(localId) ?? record);
    finishItem(current(localId) ?? record, 'done');
  } catch (error) {
    const uploadId = (current(localId) ?? record).uploadId;
    if (!uploadId) throw error;
    let upload: ServerUpload;
    try { upload = await readUpload(uploadId); }
    catch { throw error; }
    if (upload.state === 'committed') {
      finishItem(current(localId) ?? record, 'done');
      return;
    }
    if (upload.state === 'cancelled' || cancelled(localId)) {
      if (upload.state !== 'cancelled') await deleteUpload(uploadId);
      finishItem(current(localId) ?? record, 'cancelled');
      return;
    }
    if (upload.state === 'ready') {
      await retryReady(uploadId);
      return;
    }
    if (upload.state === 'failed') {
      await reupload(uploadId);
      return;
    }
    if (upload.state === 'receiving' || upload.state === 'pending') {
      update(localId, { status: 'uploading', error: undefined });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await delay(400);
        if (cancelled(localId)) {
          await deleteUpload(uploadId);
          finishItem(current(localId) ?? record, 'cancelled');
          return;
        }
        const again = await readUpload(uploadId);
        if (again.state === 'committed') { finishItem(current(localId) ?? record, 'done'); return; }
        if (again.state === 'cancelled') { finishItem(current(localId) ?? record, 'cancelled'); return; }
        if (again.state === 'ready') { await retryReady(uploadId); return; }
        if (again.state === 'failed') { await reupload(uploadId); return; }
      }
      void watchUpload(localId, uploadId);
      return;
    }
    throw error;
  }
}

async function watchUpload(localId: string, uploadId: string) {
  const record = current(localId);
  if (!record) return;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await delay(1000);
    if (settled.has(localId)) return;
    if (cancelled(localId)) {
      await deleteUpload(uploadId);
      finishItem(current(localId) ?? record, 'cancelled');
      return;
    }
    try {
      const upload = await readUpload(uploadId);
      if (upload.state === 'committed') { finishItem(current(localId) ?? record, 'done'); return; }
      if (upload.state === 'cancelled') { finishItem(current(localId) ?? record, 'cancelled'); return; }
      if (upload.state === 'ready') {
        await sendCommit({ ...(current(localId) ?? record), uploadId });
        finishItem(current(localId) ?? record, 'done');
        return;
      }
      if (upload.state === 'failed') {
        const latest = current(localId) ?? record;
        await putBytes(uploadId, latest.file, localId, (progress) => update(localId, { progress }));
        await sendCommit({ ...latest, uploadId });
        finishItem(current(localId) ?? record, 'done');
        return;
      }
      update(localId, { status: 'uploading', error: undefined });
    } catch (error) {
      finishItem(current(localId) ?? record, 'failed', error instanceof Error ? error.message : t('library:upload.statusUnconfirmed'));
      return;
    }
  }
  if (!settled.has(localId)) finishItem(current(localId) ?? record, 'failed', t('library:upload.statusUnconfirmed'));
}

async function runUpload(localId: string) {
  const record = current(localId);
  if (!record) return;
  try {
    if (cancelled(localId)) {
      finishItem(record, 'cancelled');
      return;
    }
    update(localId, { status: 'uploading', progress: null, error: undefined });
    const opened = await api<OpenedUpload>('/api/v1/library/uploads', {
      method: 'POST',
      body: JSON.stringify({ requestKey: record.requestKey, fileName: record.name, mimeType: record.file.type || 'application/octet-stream', size: record.file.size }),
    });
    update(localId, { uploadId: opened.id });
    if (cancelled(localId)) {
      await deleteUpload(opened.id);
      finishItem(current(localId) ?? record, 'cancelled');
      return;
    }
    if (opened.state === 'committed') {
      finishItem(current(localId) ?? record, 'done');
      return;
    }
    if (opened.state === 'cancelled') {
      finishItem(current(localId) ?? record, 'cancelled');
      return;
    }
    const latestTarget = (current(localId) ?? record).target;
    const folderId = latestTarget.replaceMaterialId ? (current(localId)?.folderId ?? null) : await folderForPath(record.relativePath, latestTarget.folderId);
    update(localId, { folderId });
    if (opened.state === 'receiving') {
      update(localId, { status: 'uploading', folderId });
      void watchUpload(localId, opened.id);
      return;
    }
    let duplicates: MaterialSummary[] = [];
    if (opened.state !== 'ready') {
      const ready = await putBytes(opened.id, record.file, localId, (progress) => update(localId, { progress }));
      duplicates = ready.duplicates ?? [];
      update(localId, { uploadId: ready.id || opened.id, progress: 1, folderId });
    } else {
      update(localId, { progress: 1, folderId });
    }
    if (cancelled(localId)) {
      await deleteUpload(opened.id);
      finishItem(current(localId) ?? record, 'cancelled');
      return;
    }
    const staged = current(localId) ?? record;
    if (duplicates.length && !staged.target.replaceMaterialId) {
      update(localId, { status: 'duplicate', duplicates, uploadId: opened.id, folderId, progress: 1 });
      return;
    }
    update(localId, { status: 'creating', uploadId: opened.id, folderId, progress: 1 });
    await commitWithRecovery({ ...staged, uploadId: opened.id, folderId, status: 'creating' });
  } catch (error) {
    if (cancelled(localId) || (error instanceof DOMException && error.name === 'AbortError')) {
      const uploadId = current(localId)?.uploadId;
      if (uploadId) await deleteUpload(uploadId);
      finishItem(current(localId) ?? record, 'cancelled');
      return;
    }
    const message = error instanceof ApiError || error instanceof Error ? error.message : t('library:upload.failed');
    finishItem(current(localId) ?? record, 'failed', message);
  }
}

function schedule() {
  for (const record of records) {
    if (record.status !== 'queued' || record.cancelRequested) continue;
    if (active >= poolLimit) return;
    active += 1;
    update(record.localId, { status: 'uploading', progress: null, error: undefined });
    void runGuarded(record.localId);
  }
}

async function runGuarded(localId: string) {
  try {
    const record = current(localId);
    if (!record || record.cancelRequested) {
      if (record) finishItem(record, 'cancelled');
      return;
    }
    await runUpload(localId);
  } finally {
    active = Math.max(0, active - 1);
    schedule();
  }
}

export async function enqueueUploads(files: Array<{ file: File; relativePath: string }>, target: UploadTarget) {
  const sorted = files.slice().sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'));
  const batchId = crypto.randomUUID();
  const accepted: UploadRecord[] = [];
  const rejected: UploadRecord[] = [];
  for (const item of sorted) {
    const record: UploadRecord = {
      localId: crypto.randomUUID(),
      requestKey: crypto.randomUUID(),
      file: item.file,
      relativePath: item.relativePath,
      name: item.file.name.slice(0, 255),
      status: 'queued',
      progress: null,
      batchId,
      target,
      action: 'create',
    };
    try {
      assertRelativePath(item.relativePath);
      if (!record.name) throw new Error(t('library:upload.invalidFileName'));
      accepted.push(record);
    } catch (error) {
      rejected.push({ ...record, status: 'failed', error: error instanceof Error ? error.message : t('library:upload.invalidPath') });
    }
  }
  const pending = accepted.length + rejected.length;
  if (!pending) return;
  let resolveBatch = () => {};
  const done = new Promise<void>((resolve) => { resolveBatch = resolve; });
  batches.set(batchId, { pending, added: 0, failed: 0, toasted: false, silent: Boolean(target.silent), resolve: resolveBatch });
  records = [...records, ...rejected, ...accepted];
  emit();
  for (const record of rejected) finishItem(record, 'failed', record.error);
  schedule();
  await done;
}

export async function stageUpload(file: File, relativePath = file.name) {
  const requestKey = crypto.randomUUID();
  const opened = await api<{ id: string }>('/api/v1/library/uploads', {
    method: 'POST',
    body: JSON.stringify({ requestKey, fileName: file.name.slice(0, 255), mimeType: file.type || 'application/octet-stream', size: file.size }),
  });
  await putBytes(opened.id, file, requestKey, () => {});
  return opened.id;
}

export async function retryUpload(localId: string) {
  const record = current(localId);
  if (!record || record.status !== 'failed') return;
  settled.delete(localId);
  const batchId = `retry-${crypto.randomUUID()}`;
  let resolveBatch = () => {};
  const done = new Promise<void>((resolve) => { resolveBatch = resolve; });
  batches.set(batchId, { pending: 1, added: 0, failed: 0, toasted: false, silent: Boolean(record.target.silent), resolve: resolveBatch });
  update(localId, { batchId, status: 'queued', error: undefined, cancelRequested: false, progress: null });
  schedule();
  await done;
}

export function cancelQueued(localId: string) {
  const record = current(localId);
  if (!record || settled.has(localId)) return;
  update(localId, { cancelRequested: true });
  const xhr = xhrs.get(localId);
  if (xhr) {
    xhr.abort();
    return;
  }
  if (record.status === 'queued') {
    finishItem({ ...record, cancelRequested: true }, 'cancelled');
    return;
  }
  if (record.status === 'duplicate') {
    void (async () => {
      if (record.uploadId) await deleteUpload(record.uploadId);
      finishItem(current(localId) ?? record, 'cancelled');
    })();
    return;
  }
}

export function clearFinishedUploads() {
  const finished = new Set(['done', 'skipped', 'cancelled']);
  records = records.filter((item) => !finished.has(item.status));
  emit();
}

export async function resolveDuplicate(localId: string, action: 'reuse' | 'create' | 'skip', _target: UploadTarget, reuseMaterialId?: string) {
  const record = current(localId);
  if (!record || record.status !== 'duplicate') return;
  if (action === 'reuse' && !reuseMaterialId) return;
  if (action === 'skip') {
    if (record.uploadId) await deleteUpload(record.uploadId);
    finishItem(record, 'skipped');
    return;
  }
  try {
    const folderId = record.folderId === undefined ? await folderForPath(record.relativePath, record.target.folderId) : record.folderId;
    update(localId, { status: 'creating', folderId, action: action === 'reuse' ? 'reuse' : 'create', reuseMaterialId: action === 'reuse' ? reuseMaterialId : undefined });
    const next = current(localId) ?? record;
    await commitWithRecovery({ ...next, folderId, action: action === 'reuse' ? 'reuse' : 'create', reuseMaterialId: action === 'reuse' ? reuseMaterialId : undefined });
  } catch (error) {
    finishItem(current(localId) ?? record, 'failed', error instanceof Error ? error.message : t('library:upload.saveFailed'));
  }
}

export async function submitInBatches(commands: Command[]) {
  const results = [];
  for (let index = 0; index < commands.length; index += 50) {
    results.push(await submitCommands(commands.slice(index, index + 50)));
  }
  return results;
}
