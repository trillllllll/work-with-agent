import { api } from '@/lib/api.js';

export async function readExtractedText(resourceId: string, revision: number, signal: AbortSignal, excerptNotice: string) {
  const page = await api<{ items: Array<{ text: string }>; nextCursor: number | null }>(`/api/v1/library/materials/${encodeURIComponent(resourceId)}/content?revision=${revision}&limit=100`, { signal });
  // Some cached/relay responses can resolve despite cancellation. Do not return their stale text.
  signal.throwIfAborted();
  return page.items.map((item) => item.text).join('\n\n') + (page.nextCursor !== null ? `\n\n${excerptNotice}` : '');
}
