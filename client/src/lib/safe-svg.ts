import DOMPurify from 'dompurify';
import { normalizeSvgDocument, prepareSvgSource, svgAllowedAttributes, svgAllowedTags } from '../../../server/src/shared/svg-policy.js';
import { t } from '@/i18n/index.js';

function normalize(source: string): string {
  const document = new DOMParser().parseFromString(source, 'image/svg+xml');
  if (document.querySelector('parsererror')) throw new Error(t('chat:visualization.invalidSvg'));
  return normalizeSvgDocument(document);
}

function sanitize(source: string): string {
  const canonical = normalize(prepareSvgSource(source));
  // Only static SVG in a Blob image, never inserted into the page's document.
  const clean = DOMPurify.sanitize(canonical, { ALLOWED_TAGS: [...svgAllowedTags], ALLOWED_ATTR: [...svgAllowedAttributes], ALLOW_DATA_ATTR: true, ALLOW_ARIA_ATTR: true, SANITIZE_DOM: false, RETURN_DOM_FRAGMENT: true });
  const verified = normalizeSvgDocument(clean);
  if (verified !== canonical) throw new Error(t('chat:visualization.sanitizerChanged'));
  return verified;
}

export function safeSvg(source: string): string {
  try { return sanitize(source); }
  catch (reason) {
    const error = reason as { svgCode?: string; attribute?: string };
    if (['attribute', 'format', 'reference', 'cycle'].includes(error?.svgCode || '')) {
      throw new Error(t(`chat:visualization.policy.${error.svgCode}`, { attribute: error.attribute }));
    }
    throw reason;
  }
}
