import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.js';
import type { LocalRichBlock, LocalRichDocument } from './richdoc-codec.js';

export const richDocumentEditBudget = { blocks: 500, bytes: 256 * 1024 };
const blockPageSize = 100;
const textPageSize = 10_000;

/** Count JSON UTF-8 bytes without allocating a second copy of a large string. Stop at the budget. */
function stringBytes(text: string, remaining: number) {
  let bytes = 2;
  for (let index = 0; index < text.length && bytes <= remaining; index++) {
    const char = text.charCodeAt(index);
    if (char === 34 || char === 92) bytes += 2;
    else if (char < 32) bytes += [8, 9, 10, 12, 13].includes(char) ? 2 : 6;
    else if (char < 128) bytes += 1;
    else if (char < 2048) bytes += 2;
    else if (char >= 0xd800 && char <= 0xdbff && index + 1 < text.length && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index++; }
    else bytes += char >= 0xd800 && char <= 0xdfff ? 6 : 3;
  }
  return bytes;
}

/** Iterative and early-exit: an oversized document must not reach the interactive editor. */
export function measureRichDocument(value: LocalRichDocument, budget = richDocumentEditBudget) {
  let blocks = 0; let bytes = 0;
  const pending: unknown[] = [value];
  while (pending.length && blocks <= budget.blocks && bytes <= budget.bytes) {
    const current = pending.pop();
    if (typeof current === 'string') bytes += stringBytes(current, budget.bytes - bytes);
    else if (Array.isArray(current)) { bytes += 2 + Math.max(0, current.length - 1); for (let index = current.length - 1; index >= 0; index--) pending.push(current[index]); }
    else if (current && typeof current === 'object') {
      const record = current as Record<string, unknown>;
      if (typeof record.id === 'string' && typeof record.kind === 'string') blocks++;
      const keys = Object.keys(record).filter((key) => record[key] !== undefined);
      bytes += 2 + Math.max(0, keys.length - 1) + keys.length;
      for (const key of keys) { bytes += stringBytes(key, budget.bytes - bytes); pending.push(record[key]); }
    } else bytes += current === null ? 4 : String(current).length;
  }
  return { blocks, bytes, withinBudget: blocks <= budget.blocks && bytes <= budget.bytes };
}

function* readableText(blocks: LocalRichBlock[]): Generator<string> {
  const pending: Array<LocalRichBlock | string> = [...blocks].reverse();
  while (pending.length) {
    const block = pending.pop()!;
    if (typeof block === 'string') { yield block; continue; }
    if (block.kind === 'upload') { yield block.label; yield '\n'; continue; }
    if (block.text) for (const run of block.text) yield run.break ? '\n' : run.text;
    if (block.kind === 'image') yield [block.alt, block.caption].filter(Boolean).join(' — ');
    if (block.kind === 'file') yield block.label || '';
    pending.push('\n');
    if (block.children) for (let index = block.children.length - 1; index >= 0; index--) pending.push(block.children[index]);
  }
}

/** Slice the read-only view by Unicode characters, retaining all authoritative content in the session. */
export function richDocumentTextPage(blocks: LocalRichBlock[], page: number, size = textPageSize) {
  const from = Math.max(0, page) * size; let position = 0; const text: string[] = [];
  for (const part of readableText(blocks)) for (const char of part) {
    if (position >= from + size) return { text: text.join(''), hasNext: true };
    if (position >= from) text.push(char);
    position++;
  }
  return { text: text.join(''), hasNext: false };
}

export function richDocumentBlockPage(blocks: LocalRichBlock[], blockId: string) {
  for (let index = 0; index < blocks.length; index++) {
    const pending = [blocks[index]];
    while (pending.length) {
      const block = pending.pop()!;
      if (block.id === blockId) return Math.floor(index / blockPageSize);
      if (block.kind !== 'upload' && block.children) for (const child of block.children) pending.push(child);
    }
  }
  return null;
}

export function RichDocumentBoundary({ value, renderEditor, deferPagination = false }: { value: LocalRichDocument; renderEditor: (page: LocalRichDocument, readOnly: boolean) => ReactNode; deferPagination?: boolean }) {
  const { t } = useTranslation('library');
  const container = useRef<HTMLDivElement>(null);
  const measurement = useMemo(() => measureRichDocument(value), [value]);
  const [page, setPage] = useState(0); const [textPage, setTextPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(value.blocks.length / blockPageSize));
  const current = Math.min(page, pageCount - 1);
  useEffect(() => setTextPage(0), [value, current]);
  useEffect(() => {
    const scroll = container.current?.closest('.document-scroll');
    if (!scroll) return;
    const reveal = (event: Event) => {
      const id = (event as CustomEvent<{ blockId?: string }>).detail?.blockId;
      if (!id) return;
      const next = richDocumentBlockPage(value.blocks, id);
      if (next === null) return;
      setPage(next); setTextPage(0);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const block = container.current?.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(id)}"]`);
        (block ?? container.current)?.scrollIntoView({ block: 'start' });
      }));
    };
    scroll.addEventListener('dovun-document-reveal', reveal);
    return () => scroll.removeEventListener('dovun-document-reveal', reveal);
  }, [value, measurement.withinBudget]);
  const reading = useMemo<LocalRichDocument>(() => ({ ...value, blocks: value.blocks.slice(current * blockPageSize, (current + 1) * blockPageSize) }), [value, current]);
  const pageMeasurement = useMemo(() => measurement.withinBudget || deferPagination ? measurement : measureRichDocument(reading), [measurement, reading, deferPagination]);
  const excerpt = useMemo(() => pageMeasurement.withinBudget || deferPagination ? null : richDocumentTextPage(reading.blocks, textPage), [pageMeasurement, reading, textPage, deferPagination]);
  if (measurement.withinBudget || deferPagination) return <>{renderEditor(value, false)}</>;
  const scrollToPage = () => requestAnimationFrame(() => container.current?.scrollIntoView({ block: 'start' }));
  const navigate = (next: number) => { setPage(next); setTextPage(0); scrollToPage(); };
  const navigateText = (next: number) => { setTextPage(next); scrollToPage(); };
  const navigation = <div className="flex flex-wrap items-center gap-2 py-2" aria-label={t('document.largePageNavigation')}><Button size="sm" variant="outline" disabled={current === 0} onClick={() => navigate(current - 1)}>{t('shared.previousPage')}</Button><span className="library-meta">{t('document.largePage', { page: current + 1, total: pageCount })}</span><Button size="sm" variant="outline" disabled={current + 1 >= pageCount} onClick={() => navigate(current + 1)}>{t('shared.nextPage')}</Button></div>;
  return <div ref={container} className="document-large-reading" data-testid="document-large-reading">
    <p className="document-notice" role="status">{t('document.largeReadOnly')}</p>
    {navigation}
    {excerpt ? <section><p className="library-meta">{t('document.largeTextFallback')}</p><div className="flex items-center gap-2 py-2"><Button size="sm" variant="outline" disabled={textPage === 0} onClick={() => navigateText(textPage - 1)}>{t('document.previousText')}</Button><span className="library-meta">{t('document.textPage', { page: textPage + 1 })}</span><Button size="sm" variant="outline" disabled={!excerpt.hasNext} onClick={() => navigateText(textPage + 1)}>{t('document.nextText')}</Button></div><pre className="whitespace-pre-wrap break-words text-sm">{excerpt.text}</pre></section> : renderEditor(reading, true)}
    {pageCount > 1 && navigation}
  </div>;
}
