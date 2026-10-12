import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { ApiError, api, authHeaders } from '@/lib/api.js';
import { submitCommands, type Command } from '@/lib/platform.js';
import type { MaterialSummary } from './types.js';

export type UploadStatus = 'queued' | 'uploading' | 'duplicate' | 'creating' | 'done' | 'failed' | 'skipped';

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
};

export type UploadTarget = { topicId: string | null; folderId: string | null; taskIds: string[] };

type DirectoryReader = { readEntries: (success: (entries: FileSystemEntry[]) => void, failure: (error: DOMException) => void) => void };

type ReadyUpload = { id: string; state: 'ready'; sha256: string; actualSize: number; duplicates: MaterialSummary[] };

let records: UploadRecord[] = [];
const listeners = new Set<() => void>();
const changed = new Set<() => void>();
const batches = new Map<string, { pending: number; added: number; failed: number; toasted: boolean }>();

function emit() {
  records = records.slice();
  listeners.forEach((listener) => listener());
}

function update(localId: string, patch: Partial<UploadRecord>) {
  records = records.map((item) => item.localId === localId ? { ...item, ...patch } : item);
  emit();
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

export function uploadRequestKey(file: File, relativePath: string) {
  return `${file.name}\n${file.size}\n${file.lastModified}\n${relativePath}`.slice(0, 200);
}

export function assertRelativePath(path: string) {
  if (!path || path.includes('\0')) throw new Error('路径无效');
  if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(path)) throw new Error('路径无效');
  const parts = path.split(/[\\/]/);
  if (parts.some((part) => part === '' || part === '.' || part === '..')) throw new Error('路径无效');
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

function putBytes(id: string, file: File, onProgress: (value: number | null) => void) {
  return new Promise<ReadyUpload>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/v1/library/uploads/${encodeURIComponent(id)}/content`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    for (const [key, value] of Object.entries(authHeaders())) xhr.setRequestHeader(key, value);
    xhr.upload.onprogress = (event) => onProgress(event.lengthComputable && event.total > 0 ? event.loaded / event.total : null);
    xhr.onerror = () => reject(new Error('上传失败'));
    xhr.onload = () => {
      let body: { data?: ReadyUpload; error?: string | { message?: string } } = {};
      try { body = JSON.parse(xhr.responseText) as typeof body; } catch { /* The status still decides success. */ }
      if (xhr.status >= 200 && xhr.status < 300 && body.data) resolve(body.data);
      else reject(new Error(typeof body.error === 'string' ? body.error : body.error?.message || '上传失败'));
    };
    xhr.send(file);
  });
}

function folderLabel(value: string) {
  const name = value.normalize('NFKC').trim().replace(/[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/gu, ' ');
  const length = Array.from(name).length;
  if (length < 1 || length > 80) throw new Error('文件夹名称需要 1 到 80 个字符');
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
  for (const folder of listed.items) folderIds.set(`${folder.parentId ?? ''}\n${folder.name.toLowerCase()}`, folder.id);
}

async function ensureFolder(parentId: string | null, rawName: string) {
  const name = folderLabel(rawName);
  const key = `${parentId ?? ''}\n${name.toLowerCase()}`;
  const cached = folderIds.get(key);
  if (cached) return cached;
  await rememberFolders();
  const existing = folderIds.get(key);
  if (existing) return existing;
  const created = await submitCommands([{ kind: 'libraryFolder.create', input: { parentId, name } }], `library-folder:${key}`);
  const id = created.results?.[0]?.id as string | undefined;
  if (!id) throw new Error('文件夹没有创建');
  folderIds.set(key, id);
  return id;
}

export async function folderForPath(relativePath: string, root: string | null) {
  const parts = relativePath.split('/').slice(0, -1);
  return lockFolders(async () => {
    let parent = root;
    for (const part of parts) parent = await ensureFolder(parent, part);
    return parent;
  });
}

async function createMaterial(record: UploadRecord, target: UploadTarget, action: 'create' | 'reuse', reuseMaterialId?: string) {
  const folderId = record.folderId === undefined ? await folderForPath(record.relativePath, target.folderId) : record.folderId;
  const command: Command = {
    kind: 'material.create',
    input: {
      uploadId: record.uploadId,
      duplicateAction: action,
      ...(reuseMaterialId ? { reuseMaterialId } : {}),
      topicId: target.topicId,
      folderId,
      taskIds: target.taskIds,
    },
  };
  await submitCommands([command], `library-upload:${record.requestKey}:${action}:${reuseMaterialId ?? ''}:${folderId ?? ''}`);
}

function finishItem(record: UploadRecord, status: 'done' | 'failed' | 'skipped', error?: string) {
  update(record.localId, { status, error, progress: status === 'done' ? 1 : record.progress });
  const batch = batches.get(record.batchId);
  if (!batch) return;
  batch.pending -= 1;
  if (status === 'done') batch.added += 1;
  if (status === 'failed') batch.failed += 1;
  if (batch.pending === 0 && !batch.toasted) {
    batch.toasted = true;
    toast.success(`已添加 ${batch.added} 份资料，${batch.failed} 份失败`);
    if (batch.added) notifyChanged();
  }
}

async function runUpload(record: UploadRecord, target: UploadTarget) {
  try {
    update(record.localId, { status: 'uploading', progress: null, error: undefined });
    const opened = await api<{ id: string; state: string; maxBytes: number }>('/api/v1/library/uploads', {
      method: 'POST',
      body: JSON.stringify({ requestKey: record.requestKey, fileName: record.name, mimeType: record.file.type || 'application/octet-stream', size: record.file.size }),
    });
    update(record.localId, { uploadId: opened.id });
    const ready = await putBytes(opened.id, record.file, (progress) => update(record.localId, { progress }));
    const folderId = await folderForPath(record.relativePath, target.folderId);
    const current = records.find((item) => item.localId === record.localId) ?? record;
    const next = { ...current, uploadId: ready.id, folderId, target };
    if (ready.duplicates?.length) {
      update(record.localId, { status: 'duplicate', uploadId: ready.id, duplicates: ready.duplicates, progress: 1, folderId });
      return;
    }
    update(record.localId, { status: 'creating', uploadId: ready.id, progress: 1, folderId });
    await createMaterial(next, target, 'create');
    finishItem(next, 'done');
    notifyChanged();
  } catch (error) {
    const message = error instanceof ApiError || error instanceof Error ? error.message : '上传失败';
    finishItem(record, 'failed', message);
  }
}

async function pump(queue: UploadRecord[], target: UploadTarget) {
  let index = 0;
  const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (index < queue.length) {
      const current = queue[index];
      index += 1;
      if (current) await runUpload(current, target);
    }
  });
  await Promise.all(workers);
}

export async function enqueueUploads(files: Array<{ file: File; relativePath: string }>, target: UploadTarget) {
  const sorted = files.slice().sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'));
  const batchId = crypto.randomUUID();
  const accepted: UploadRecord[] = [];
  const rejected: UploadRecord[] = [];
  for (const item of sorted) {
    const record: UploadRecord = {
      localId: crypto.randomUUID(),
      requestKey: uploadRequestKey(item.file, item.relativePath),
      file: item.file,
      relativePath: item.relativePath,
      name: item.file.name.slice(0, 255),
      status: 'queued',
      progress: null,
      batchId,
      target,
    };
    try {
      assertRelativePath(item.relativePath);
      if (!record.name) throw new Error('文件名无效');
      accepted.push(record);
    } catch (error) {
      rejected.push({ ...record, status: 'failed', error: error instanceof Error ? error.message : '路径无效' });
    }
  }
  const batch = { pending: accepted.length + rejected.length, added: 0, failed: 0, toasted: false };
  if (!batch.pending) return;
  batches.set(batchId, batch);
  records = [...records, ...rejected, ...accepted];
  emit();
  for (const record of rejected) finishItem(record, 'failed', record.error);
  if (accepted.length) await pump(accepted, target);
}

export async function stageUpload(file: File, relativePath = file.name) {
  const requestKey = uploadRequestKey(file, assertRelativePath(relativePath));
  const opened = await api<{ id: string }>('/api/v1/library/uploads', {
    method: 'POST',
    body: JSON.stringify({ requestKey, fileName: file.name.slice(0, 255), mimeType: file.type || 'application/octet-stream', size: file.size }),
  });
  await putBytes(opened.id, file, () => {});
  return opened.id;
}

export async function retryUpload(localId: string) {
  const record = records.find((item) => item.localId === localId);
  if (!record || record.status !== 'failed') return;
  const batchId = `retry-${crypto.randomUUID()}`;
  batches.set(batchId, { pending: 1, added: 0, failed: 0, toasted: false });
  const next = { ...record, batchId, status: 'queued' as const, error: undefined };
  update(localId, { batchId, status: 'queued', error: undefined });
  await runUpload(next, record.target);
}

export async function resolveDuplicate(localId: string, action: 'reuse' | 'create' | 'skip', target: UploadTarget, reuseMaterialId?: string) {
  const record = records.find((item) => item.localId === localId);
  if (!record || record.status !== 'duplicate') return;
  if (action === 'skip') {
    finishItem(record, 'skipped');
    return;
  }
  try {
    update(localId, { status: 'creating' });
    await createMaterial(record, target, action === 'reuse' ? 'reuse' : 'create', action === 'reuse' ? reuseMaterialId : undefined);
    finishItem({ ...record, status: 'creating' }, 'done');
    notifyChanged();
  } catch (error) {
    finishItem(record, 'failed', error instanceof Error ? error.message : '保存失败');
  }
}

export async function submitInBatches(commands: Command[]) {
  const results = [];
  for (let index = 0; index < commands.length; index += 50) {
    results.push(await submitCommands(commands.slice(index, index + 50)));
  }
  return results;
}
