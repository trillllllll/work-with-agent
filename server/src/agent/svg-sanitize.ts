import { DOMParser } from '@xmldom/xmldom';
import { normalizeSvgDocument, prepareSvgSource } from '../shared/svg-policy.js';

export function sanitizeSvg(source: string): string {
  const document = new DOMParser({ onError: () => { throw new Error('SVG XML 格式无效'); } }).parseFromString(prepareSvgSource(source), 'image/svg+xml');
  return normalizeSvgDocument(document as unknown as Parameters<typeof normalizeSvgDocument>[0]);
}
