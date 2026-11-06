import { htmlFragments, svgCandidate } from '../shared/streaming-markup.js';
import { sanitizeSvg } from './svg-sanitize.js';
/** Match the renderer's complete-prefix boundary before recording delivered study help. */
export function sourcePreviewAvailable(type: string, source: string) {
  try {
    if (type === 'svg') {
      const svg = sanitizeSvg(svgCandidate(source)).replace(/<(defs|metadata|style|title|desc)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
      return /<(?:path|rect|circle|ellipse|line|polyline|polygon|text|use)\b/i.test(svg);
    }
    if (type === 'html') return htmlFragments(source).parts.some(part => !/^\s*(?:<!--[\s\S]*?-->\s*)*<style\b/i.test(part));
    // Mermaid needs its real browser parser, so study delivery waits for a safe-render acknowledgement.
    return false;
  } catch { return false; }
}
