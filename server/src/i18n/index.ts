import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';
import { en } from './locales/en.js';

/**
 * Server-side i18n. Messages are written in Chinese (zh-CN, the default) in the
 * source; `locales/en.ts` maps each source message (templates use positional
 * `{0}` placeholders) to English. Translation happens only at the HTTP boundary,
 * so stored data, model-facing tool results and tests keep the source wording.
 *
 * Locale per request: `X-WWA-Language` (the client's explicit setting), then
 * `Accept-Language`, then zh-CN.
 */
export const supportedLocales = ['zh-CN', 'en'] as const;
export type Locale = (typeof supportedLocales)[number];
export const defaultLocale: Locale = 'zh-CN';

const storage = new AsyncLocalStorage<Locale>();

export function normalizeLocale(value: string | null | undefined): Locale | null {
  const tag = (value ?? '').trim().toLowerCase();
  if (!tag) return null;
  if (tag.startsWith('en')) return 'en';
  if (tag.startsWith('zh')) return 'zh-CN';
  return null;
}

/** Picks the first supported language from an Accept-Language header, honouring q-values. */
export function localeFromAcceptLanguage(header: string | undefined): Locale | null {
  if (!header) return null;
  const ranked = header.split(',').map((part, index) => {
    const [tag, ...params] = part.trim().split(';');
    const q = params.map((param) => param.trim()).find((param) => param.startsWith('q='));
    return { tag, q: q ? Number(q.slice(2)) || 0 : 1, index };
  }).filter((item) => item.tag && item.q > 0).sort((a, b) => b.q - a.q || a.index - b.index);
  for (const item of ranked) { const locale = normalizeLocale(item.tag); if (locale) return locale; }
  return null;
}

export function localeFromRequest(req: Pick<Request, 'headers'>): Locale {
  const explicit = req.headers['x-dovun-language'] ?? req.headers['x-wwa-language'];
  return normalizeLocale(Array.isArray(explicit) ? explicit[0] : explicit)
    ?? localeFromAcceptLanguage(typeof req.headers['accept-language'] === 'string' ? req.headers['accept-language'] : undefined)
    ?? defaultLocale;
}

export function currentLocale(): Locale { return storage.getStore() ?? defaultLocale; }
/** The locale of the HTTP request being handled, if any (used to forward it, e.g. from MCP to the API). */
export function requestLocale(): Locale | undefined { return storage.getStore(); }
export function runWithLocale<T>(locale: Locale, callback: () => T): T { return storage.run(locale, callback); }

type Template = { pattern: RegExp; target: string; prefix: string };
const templates: Template[] = [];
const exact = new Map<string, string>();
const placeholder = /\{(\d+)\}/g;
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
for (const [source, target] of Object.entries(en)) {
  if (!placeholder.test(source)) { exact.set(source, target); continue; }
  placeholder.lastIndex = 0;
  const order: number[] = [];
  const pattern = source.split(placeholder).map((part, index) => {
    if (index % 2 === 0) return escape(part);
    order.push(Number(part));
    return '([\\s\\S]*?)';
  }).join('');
  templates.push({ pattern: new RegExp(`^${pattern}$`), target: target.replace(placeholder, (_, n) => `{${order.indexOf(Number(n))}}`), prefix: source.split(placeholder)[0] });
}
const cjk = /[\u3400-\u9fff]/;

/** Translates one server message into the locale; unknown text is returned unchanged. */
export function translateMessage(message: string, locale: Locale = currentLocale()): string {
  if (locale === defaultLocale || !cjk.test(message)) return message;
  const direct = exact.get(message);
  if (direct !== undefined) return direct;
  if (message.length <= 2000) {
    for (const template of templates) {
      if (!message.startsWith(template.prefix)) continue;
      const match = template.pattern.exec(message);
      if (match) return template.target.replace(placeholder, (_, n) => match[Number(n) + 1] ?? '');
    }
  }
  // Joined messages such as "a；b" or "a; b" are translated part by part.
  const parts = message.split(/(；|; )/);
  if (parts.length > 1) {
    const translated = parts.map((part, index) => index % 2 ? '; ' : translateMessage(part, locale));
    if (translated.some((part, index) => index % 2 === 0 && part !== parts[index])) return translated.join('');
  }
  return message;
}

/** Translates a zh-CN label the server puts into response data (not error text) into the request locale. */
export function localize(message: string): string { return translateMessage(message, currentLocale()); }

const messageKeys = /^(error|message|errorMessage|summaryError|reason|warning|warnings|detail|lastError|failureMessage|statusMessage|formErrors)$/;

/** Translates message-like fields (error, message, reason, warnings…) anywhere in a JSON payload. */
export function translatePayload<T>(value: T, locale: Locale = currentLocale(), key?: string, depth = 0): T {
  if (locale === defaultLocale || depth > 12 || value === null || value === undefined) return value;
  if (typeof value === 'string') return (key && messageKeys.test(key) ? translateMessage(value, locale) : value) as T;
  if (Array.isArray(value)) return value.map((item) => translatePayload(item, locale, key, depth + 1)) as T;
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      const next = translatePayload(child, locale, childKey, depth + 1);
      if (next !== child) changed = true;
      out[childKey] = next;
    }
    return (changed ? out : value) as T;
  }
  return value;
}

/** Resolves the request locale and translates JSON responses on the way out. */
export function localeMiddleware(req: Request, res: Response, next: NextFunction) {
  const locale = localeFromRequest(req);
  res.locals.locale = locale;
  if (locale !== defaultLocale) {
    const json = res.json.bind(res);
    res.json = (body?: unknown) => json(translatePayload(body, locale));
  }
  runWithLocale(locale, () => next());
}
