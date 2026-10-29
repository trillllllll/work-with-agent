import { authHeaders } from '@/lib/api.js';

export const readerByteBudget = 32 * 1024 * 1024;
export async function readResourceBytes(url: string, signal: AbortSignal, limit = readerByteBudget): Promise<ArrayBuffer> {
  const response = await fetch(url, { credentials: 'include', headers: authHeaders(), signal });
  if (!response.ok) throw new Error(`FILE_READ_FAILED (${response.status})`);
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new Error('READER_BUDGET_EXCEEDED'); }
  const reader = response.body?.getReader();
  if (!reader) { const bytes = await response.arrayBuffer(); if (bytes.byteLength > limit) throw new Error('READER_BUDGET_EXCEEDED'); return bytes; }
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > limit) { await reader.cancel(); throw new Error('READER_BUDGET_EXCEEDED'); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes.buffer;
}
