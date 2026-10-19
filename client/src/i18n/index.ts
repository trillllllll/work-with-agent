import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';

export const supportedLanguages = ['zh-CN', 'en'] as const;
export type Language = (typeof supportedLanguages)[number];
export const defaultLanguage: Language = 'zh-CN';
export const languageStorageKey = 'wwa.language';

type Resources = Record<string, Record<string, Record<string, unknown>>>;
const files = import.meta.glob('./locales/*/*.json', { eager: true, import: 'default' }) as Record<string, Record<string, unknown>>;
const resources: Resources = {};
for (const [path, messages] of Object.entries(files)) {
  const match = path.match(/\.\/locales\/([^/]+)\/([^/]+)\.json$/);
  if (!match) continue;
  const [, language, namespace] = match;
  (resources[language] ??= {})[namespace] = messages;
}
export const namespaces = Object.keys(resources[defaultLanguage] ?? {});

/** Map any browser tag (zh, zh-TW, en-GB…) onto a supported language. */
export function normalizeLanguage(value: string | null | undefined): Language {
  const tag = (value ?? '').toLowerCase();
  if (tag.startsWith('en')) return 'en';
  return defaultLanguage;
}

// Detection only makes sense in a browser; Node (tests) exposes navigator.language too.
const inBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';
if (inBrowser) i18n.use(LanguageDetector);
void i18n.use(initReactI18next).init({
  resources,
  ns: namespaces,
  defaultNS: 'common',
  fallbackNS: 'common',
  fallbackLng: defaultLanguage,
  supportedLngs: [...supportedLanguages],
  ...(inBrowser ? {} : { lng: defaultLanguage }),
  interpolation: { escapeValue: false },
  returnNull: false,
  detection: {
    order: ['localStorage', 'navigator'],
    lookupLocalStorage: languageStorageKey,
    caches: [],
    convertDetectedLanguage: (lng: string) => normalizeLanguage(lng),
  },
  react: { useSuspense: false },
});

function syncDocument(language: string) {
  if (inBrowser) document.documentElement.lang = normalizeLanguage(language);
}
syncDocument(i18n.language);
i18n.on('languageChanged', syncDocument);

export function currentLanguage(): Language {
  return normalizeLanguage(i18n.resolvedLanguage ?? i18n.language);
}

/** BCP 47 tag for Intl / toLocale* formatting in the current language. */
export function intlLocale(): string {
  return currentLanguage() === 'en' ? 'en-US' : 'zh-CN';
}

/** Persist an explicit choice; the browser language is only the default. */
export async function setLanguage(language: Language) {
  if (inBrowser) window.localStorage.setItem(languageStorageKey, language);
  await i18n.changeLanguage(language);
}

export const t = i18n.t.bind(i18n);
export default i18n;
