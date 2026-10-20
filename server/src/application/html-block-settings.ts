import { prisma } from '../infrastructure/prisma.js';
import { DEFAULT_HTML_CDN, normalizeCdnEntry, type HtmlBlockPolicy } from '../agent/html-block.js';

function readList(raw: string | null | undefined) {
  try {
    const value = JSON.parse(raw || 'null');
    if (!Array.isArray(value)) return [...DEFAULT_HTML_CDN];
    return [...new Set(value.map((item) => typeof item === 'string' ? normalizeCdnEntry(item) : null).filter((item): item is string => Boolean(item)))].slice(0, 20);
  } catch { return [...DEFAULT_HTML_CDN]; }
}

export async function htmlBlockPolicy(): Promise<HtmlBlockPolicy> {
  const row = await prisma.appSetting.findUnique({ where: { id: 'default' }, select: { htmlBlocksEnabled: true, htmlCdnAllowlist: true } });
  return { enabled: row?.htmlBlocksEnabled ?? true, cdn: row ? readList(row.htmlCdnAllowlist) : [...DEFAULT_HTML_CDN] };
}

export async function htmlBlockSettings() {
  return { ...await htmlBlockPolicy(), defaults: DEFAULT_HTML_CDN };
}

/** Rejects the whole update when any entry is not a plain origin, so a typo cannot silently widen or drop the list. */
export async function saveHtmlBlockSettings(input: { enabled?: boolean; cdn?: string[] }) {
  const data: { htmlBlocksEnabled?: boolean; htmlCdnAllowlist?: string } = {};
  if (input.enabled !== undefined) data.htmlBlocksEnabled = input.enabled;
  if (input.cdn !== undefined) {
    const normalized: string[] = [];
    for (const raw of input.cdn) {
      if (!raw.trim()) continue;
      const entry = normalizeCdnEntry(raw);
      if (!entry) throw Object.assign(new Error(`CDN 地址无效：${raw.slice(0, 200)}。只能填写 https://域名，不带路径`), { status: 400 });
      if (!normalized.includes(entry)) normalized.push(entry);
    }
    if (normalized.length > 20) throw Object.assign(new Error('CDN 白名单最多 20 项'), { status: 400 });
    data.htmlCdnAllowlist = JSON.stringify(normalized);
  }
  const timestamp = new Date().toISOString();
  await prisma.appSetting.upsert({ where: { id: 'default' }, create: { id: 'default', ...data, createdAt: timestamp, updatedAt: timestamp }, update: { ...data, updatedAt: timestamp } });
  return htmlBlockSettings();
}
