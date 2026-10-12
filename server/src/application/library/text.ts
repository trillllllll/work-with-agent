const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export type NormPoint = { out: number; inStart: number; inEnd: number };

const whitespace = /[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u;

export function codePoints(value: string) {
  return Array.from(value);
}

export function codePointLength(value: string) {
  return Array.from(value).length;
}

export function isWhitespace(value: string) {
  return value.length > 0 && [...value].every((char) => whitespace.test(char));
}

/** NFKC, lowercase, collapsed whitespace, with a map back to source code points. */
export function normalizeWithMap(text: string) {
  const raw: Array<{ char: string; inStart: number; inEnd: number; space: boolean }> = [];
  let cursor = 0;
  for (const { segment } of segmenter.segment(text)) {
    const length = Array.from(segment).length;
    const expanded = Array.from(segment.normalize('NFKC').toLowerCase());
    for (const char of expanded) raw.push({ char, inStart: cursor, inEnd: cursor + length, space: whitespace.test(char) });
    cursor += length;
  }
  let start = 0;
  let end = raw.length;
  while (start < end && raw[start].space) start += 1;
  while (end > start && raw[end - 1].space) end -= 1;
  let normalized = '';
  const map: NormPoint[] = [];
  for (let index = start; index < end;) {
    if (raw[index].space) {
      let next = index;
      while (next < end && raw[next].space) next += 1;
      normalized += ' ';
      map.push({ out: map.length, inStart: raw[index].inStart, inEnd: raw[next - 1].inEnd });
      index = next;
    } else {
      normalized += raw[index].char;
      map.push({ out: map.length, inStart: raw[index].inStart, inEnd: raw[index].inEnd });
      index += 1;
    }
  }
  return { normalized, map };
}

export function normalizeQuery(value: string) {
  return normalizeWithMap(value).normalized;
}

export function displayName(value: string, minimum: number, maximum: number) {
  const name = value.normalize('NFKC').trim().replace(/[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/gu, ' ');
  const length = codePointLength(name);
  if (length < minimum || length > maximum) return null;
  return { name, normalizedName: name.toLowerCase() };
}

export function indexTokens(normalized: string) {
  const result = new Set<string>();
  for (const run of normalized.split(' ')) {
    if (!run) continue;
    const units = Array.from(run);
    for (const size of [1, 2, 3]) {
      if (units.length < size) continue;
      for (let index = 0; index <= units.length - size; index += 1) result.add(`g${size}:${units.slice(index, index + size).join('')}`);
    }
  }
  return result;
}

export function queryPlan(value: string) {
  const q = normalizeQuery(value);
  const length = codePointLength(q);
  if (length < 1 || length > 200) return null;
  const terms = [...new Set(q.split(' ').filter(Boolean))];
  const tokens = new Set<string>();
  for (const term of terms) {
    const units = Array.from(term);
    const size = Math.min(3, units.length);
    for (let index = 0; index <= units.length - size; index += 1) tokens.add(`g${size}:${units.slice(index, index + size).join('')}`);
  }
  return { q, terms, tokens: [...tokens] };
}

export function sliceCodePoints(value: string, start: number, end: number) {
  return Array.from(value).slice(start, end).join('');
}

export type LocatedText = { text: string; start: number; end: number };

/** Split one extracted segment. Offsets are code points in that segment, half-open. */
export function splitSegment(text: string): LocatedText[] {
  const units = Array.from(text);
  if (!units.length) return [];
  const width = 1200;
  const overlap = 200;
  const pieces: LocatedText[] = [];
  let start = 0;
  while (start < units.length) {
    let end = Math.min(start + width, units.length);
    if (end < units.length) {
      const windowStart = Math.min(start + 800, end);
      let newline = -1;
      for (let index = end - 1; index >= windowStart; index -= 1) if (units[index] === '\n') { newline = index; break; }
      if (newline >= 0) end = newline + 1;
    }
    if (end <= start) end = Math.min(start + width, units.length);
    pieces.push({ text: units.slice(start, end).join(''), start, end });
    if (end >= units.length) break;
    const next = end - overlap;
    start = next > start ? next : end;
  }
  return pieces;
}
