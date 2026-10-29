import { SaxesParser } from 'saxes';

export const workbookReaderBudget = { rows: 1_048_576, columns: 16_384, cells: 200_000, mergeCells: 200_000, singleMergeCells: 10_000, sheets: 100 } as const;
const budgetError = () => new Error('READER_BUDGET_EXCEEDED');
function cellCoordinates(address: string) {
  const match = /^\$?([A-Z]{1,3})\$?([1-9]\d{0,6})$/i.exec(address);
  if (!match) throw budgetError();
  let column = 0;
  for (const character of match[1].toUpperCase()) column = column * 26 + character.charCodeAt(0) - 64;
  const row = Number(match[2]);
  if (row > workbookReaderBudget.rows || column > workbookReaderBudget.columns) throw budgetError();
  return { row, column };
}
function rangeArea(range: string) {
  const parts = range.split(':'); if (!parts.length || parts.length > 2) throw budgetError();
  const from = cellCoordinates(parts[0]), to = cellCoordinates(parts[1] ?? parts[0]);
  if (to.row < from.row || to.column < from.column) throw budgetError();
  return (to.row - from.row + 1) * (to.column - from.column + 1);
}

/** Read ZIP central-directory sizes before Office parsers allocate inflated content. No entries are decompressed here. */
export function assertOfficeArchiveBudget(bytes: ArrayBuffer, maxInflated = 64 * 1024 * 1024, maxEntries = 10_000) {
  const view = new DataView(bytes); let end = -1;
  for (let at = bytes.byteLength - 22; at >= Math.max(0, bytes.byteLength - 65_557); at--) {
    if (view.getUint32(at, true) === 0x06054b50) { end = at; break; }
  }
  if (end < 0) throw new Error('INVALID_OFFICE_ARCHIVE');
  const count = view.getUint16(end + 10, true); const directorySize = view.getUint32(end + 12, true); let cursor = view.getUint32(end + 16, true);
  if (count === 0xffff || count > maxEntries || cursor + directorySize > end || view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0) throw new Error('READER_BUDGET_EXCEEDED');
  let inflated = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) throw new Error('INVALID_OFFICE_ARCHIVE');
    inflated += view.getUint32(cursor + 24, true);
    if (inflated > maxInflated || view.getUint32(cursor + 24, true) === 0xffffffff) throw new Error('READER_BUDGET_EXCEEDED');
    cursor += 46 + view.getUint16(cursor + 28, true) + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
  }
  if (cursor > end) throw new Error('INVALID_OFFICE_ARCHIVE');
  return { count, inflated };
}

/** ZIP size fields are untrusted: verify actual streaming output before Office libraries allocate it. */
export async function verifyOfficeArchiveBudget(bytes: ArrayBuffer, signal?: AbortSignal, maxInflated = 64 * 1024 * 1024) {
  assertOfficeArchiveBudget(bytes, maxInflated);
  const { default: JSZip } = await import('jszip');
  const archive = await JSZip.loadAsync(bytes);
  let total = 0;
  let cells = 0, mergeCells = 0, sheets = 0, declaredSheets = 0;
  for (const entry of Object.values(archive.files)) {
    if (entry.dir) continue;
    signal?.throwIfAborted();
    const worksheet = /^xl\/worksheets\/[^/]+\.xml$/i.test(entry.name);
    const workbook = /^xl\/workbook\.xml$/i.test(entry.name);
    if (worksheet && ++sheets > workbookReaderBudget.sheets) throw budgetError();
    // SAX handlers retain no XML tree. All XML parts reject DTD/custom entities, including
    // parts outside the workbook that an Office library will parse after this preflight.
    const xml = /\.(?:xml|rels)$/i.test(entry.name) ? new SaxesParser({ xmlns: false }) : null;
    const decoder = xml ? new TextDecoder('utf-8', { fatal: true }) : null;
    xml?.on('doctype', () => { throw new Error('INVALID_OFFICE_ARCHIVE'); });
    xml?.on('error', () => { throw new Error('INVALID_OFFICE_ARCHIVE'); });
    xml?.on('opentag', (tag) => {
      const name = tag.name.split(':').pop(); const attrs = tag.attributes;
      if (workbook && name === 'sheet' && ++declaredSheets > workbookReaderBudget.sheets) throw budgetError();
      if (!worksheet) return;
      if (name === 'row' && attrs.r !== undefined && (!/^[1-9]\d{0,6}$/.test(attrs.r) || Number(attrs.r) > workbookReaderBudget.rows)) throw budgetError();
      if (name === 'c') {
        if (++cells > workbookReaderBudget.cells) throw budgetError();
        if (attrs.r !== undefined) cellCoordinates(attrs.r);
      }
      if (name === 'col') for (const bound of [attrs.min, attrs.max]) if (bound !== undefined && (!/^[1-9]\d{0,4}$/.test(bound) || Number(bound) > workbookReaderBudget.columns)) throw budgetError();
      if (name === 'dimension' && attrs.ref !== undefined) rangeArea(attrs.ref);
      if (name === 'mergeCell') {
        if (!attrs.ref) throw budgetError();
        const area = rangeArea(attrs.ref); mergeCells += area;
        if (area > workbookReaderBudget.singleMergeCells || mergeCells > workbookReaderBudget.mergeCells) throw budgetError();
      }
    });
    await new Promise<void>((resolve, reject) => {
      type InflateStream = { on(event: 'data', listener: (chunk: Uint8Array) => void): InflateStream; on(event: 'error', listener: (error: Error) => void): InflateStream; on(event: 'end', listener: () => void): InflateStream; pause(): void; resume(): void };
      const stream = (entry as typeof entry & { internalStream(type: 'uint8array'): InflateStream }).internalStream('uint8array'); let settled = false;
      const fail = (error: unknown) => { if (settled) return; settled = true; stream.pause(); signal?.removeEventListener('abort', abort); reject(error); };
      const abort = () => fail(new DOMException('Aborted', 'AbortError'));
      signal?.addEventListener('abort', abort, { once: true });
      stream.on('data', (chunk: Uint8Array) => {
        if (settled) return;
        total += chunk.byteLength;
        if (total > maxInflated) { fail(budgetError()); return; }
        try { if (xml && decoder) xml.write(decoder.decode(chunk, { stream: true })); } catch (error) { fail(error); }
      });
      stream.on('error', fail);
      stream.on('end', () => {
        if (settled) return;
        try { if (xml && decoder) xml.write(decoder.decode()).close(); } catch (error) { fail(error); return; }
        settled = true; signal?.removeEventListener('abort', abort); resolve();
      });
      stream.resume();
    });
  }
  return total;
}
