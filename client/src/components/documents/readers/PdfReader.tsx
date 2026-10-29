import { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { NativeSelect } from '@/components/ui/native-select.js';
import { useTranslation } from 'react-i18next';
import { boundedPdfOutline, type PdfOutlineEntry } from './navigation.js';
import { pdfjsAssetUrls } from './pdfjs-assets.js';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
type Position = { page: number; scale: number };
function readPosition(key: string): Position { try { const data = JSON.parse(sessionStorage.getItem(`dovun.pdf:${key}`) || '{}'); return { page: Math.max(1, Number(data.page) || 1), scale: Math.min(3, Math.max(.5, Number(data.scale) || 1)) }; } catch { return { page: 1, scale: 1 }; } }
export default function PdfReader({ bytes, positionKey }: { bytes: ArrayBuffer; positionKey: string }) {
  const { t } = useTranslation('library'); const canvas = useRef<HTMLCanvasElement>(null);
  const [document, setDocument] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [position, setPosition] = useState(() => readPosition(positionKey)); const [outline, setOutline] = useState<PdfOutlineEntry[]>([]); const [outlineLimited, setOutlineLimited] = useState(false);
  const [query, setQuery] = useState(''); const [hits, setHits] = useState<number[]>([]); const [searching, setSearching] = useState(false);
  const [text, setText] = useState(''); const [error, setError] = useState(''); const [showText, setShowText] = useState(false);
  const searchGeneration = useRef(0);
  useEffect(() => {
    setDocument(null); setError(''); setOutline([]); setOutlineLimited(false); setPosition(readPosition(positionKey));
    const loading = pdfjs.getDocument({ data: bytes.slice(0), enableXfa: false, stopAtErrors: true, ...pdfjsAssetUrls(pdfjs.version) });
    let alive = true;
    void loading.promise.then(async (loaded) => {
      if (!alive) return;
      setDocument(loaded); setPosition((current) => ({ ...current, page: Math.min(current.page, loaded.numPages) }));
      const items = await loaded.getOutline();
      const result = boundedPdfOutline(items ?? []);
      if (alive) { setOutline(result.entries); setOutlineLimited(result.truncated); }
    }).catch(() => { if (alive) setError(t('docsReader.failed')); });
    return () => { alive = false; searchGeneration.current += 1; void loading.destroy(); };
  }, [bytes, positionKey]);
  useEffect(() => {
    if (!document) return;
    let alive = true; let render: pdfjs.RenderTask | null = null;
    try { sessionStorage.setItem(`dovun.pdf:${positionKey}`, JSON.stringify(position)); } catch { /* Reading remains available without position persistence. */ }
    void document.getPage(position.page).then(async (page) => {
      if (!alive || !canvas.current) return;
      const natural = page.getViewport({ scale: position.scale }); const maxPixels = 8_000_000;
      const downscale = Math.min(2, window.devicePixelRatio || 1, Math.sqrt(maxPixels / (natural.width * natural.height)));
      const viewport = page.getViewport({ scale: position.scale * downscale });
      const element = canvas.current; element.width = viewport.width; element.height = viewport.height; element.style.width = `${natural.width}px`; element.style.height = `${natural.height}px`;
      render = page.render({ canvas: element, viewport }); await render.promise;
      const content = await page.getTextContent(); if (alive) setText(content.items.map((item) => 'str' in item ? item.str : '').join(' '));
    }).catch((failure: unknown) => { if (alive && !(failure instanceof Error && failure.name === 'RenderingCancelledException')) setError(t('docsReader.failed')); });
    return () => { alive = false; render?.cancel(); };
  }, [document, position, positionKey]);
  const search = async () => {
    if (!document || !query.trim()) return;
    const generation = ++searchGeneration.current; setSearching(true); const result: number[] = [];
    try {
      for (let number = 1; number <= Math.min(document.numPages, 500); number++) {
        if (generation !== searchGeneration.current) return;
        const page = await document.getPage(number); const content = await page.getTextContent();
        if (content.items.map((item) => 'str' in item ? item.str : '').join(' ').toLocaleLowerCase().includes(query.toLocaleLowerCase())) result.push(number);
        if (number !== position.page) page.cleanup();
      }
      if (generation === searchGeneration.current) { setHits(result); if (result[0]) setPosition((value) => ({ ...value, page: result[0] })); }
    } catch { if (generation === searchGeneration.current) setError(t('docsReader.failed')); }
    finally { if (generation === searchGeneration.current) setSearching(false); }
  };
  const goOutline = async (index: number) => {
    if (!document) return;
    try { const entry = outline[index]; const destination = typeof entry.dest === 'string' ? await document.getDestination(entry.dest) : entry.dest; const target = destination?.[0]; if (target === undefined || target === null) return; const page = typeof target === 'number' ? target : await document.getPageIndex(target as Parameters<pdfjs.PDFDocumentProxy['getPageIndex']>[0]); setPosition((value) => ({ ...value, page: Math.min(document.numPages, Math.max(1, page + 1)) })); }
    catch { setError(t('docsReader.failed')); }
  };
  return <div className="document-pdf-reader">
    <div className="document-reader-toolbar">
      <Button variant="ghost" size="sm" disabled={position.page <= 1} onClick={() => setPosition((value) => ({ ...value, page: value.page - 1 }))}>{t('docsReader.previous')}</Button>
      <Input aria-label={t('docsReader.page')} type="number" min="1" max={document?.numPages ?? 1} value={position.page} onChange={(event) => setPosition((value) => ({ ...value, page: Math.max(1, Math.min(document?.numPages ?? 1, Number(event.target.value) || 1)) }))} />
      <span>/ {document?.numPages ?? '…'}</span>
      <Button variant="ghost" size="sm" disabled={!document || position.page >= document.numPages} onClick={() => setPosition((value) => ({ ...value, page: value.page + 1 }))}>{t('docsReader.next')}</Button>
      <NativeSelect aria-label={t('docsReader.zoom')} value={position.scale} onChange={(event) => setPosition((value) => ({ ...value, scale: Number(event.target.value) }))}>{[.5, .75, 1, 1.25, 1.5, 2, 3].map((scale) => <option key={scale} value={scale}>{scale * 100}%</option>)}</NativeSelect>
      {outline.length > 0 && <NativeSelect aria-label={t('docsReader.outline')} value="" onChange={(event) => { void goOutline(Number(event.target.value)); }}><option value="">{t('docsReader.outline')}</option>{outline.map((entry, index) => <option key={index} value={index}>{'\u00a0\u00a0'.repeat(entry.depth)}{entry.title}</option>)}</NativeSelect>}
      <Input aria-label={t('docsReader.search')} placeholder={t('docsReader.search')} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void search(); }} />
      <Button variant="ghost" size="sm" disabled={!document || searching || !query.trim()} onClick={() => { void search(); }}>{t('docsReader.search')}</Button>
      <Button variant="ghost" size="sm" onClick={() => setShowText(!showText)}>{t('docsReader.pageText')}</Button>
    </div>
    {document && document.numPages > 500 && <p>{t('docsReader.searchLimit')}</p>}
    {outlineLimited && <p>{t('docsReader.outlineLimit')}</p>}
    {hits.length > 0 && <div className="document-reader-toolbar">{hits.map((page) => <Button key={page} variant="ghost" size="sm" onClick={() => setPosition((value) => ({ ...value, page }))}>{page}</Button>)}</div>}
    {error && <p role="alert">{error}</p>}
    <div className="document-pdf-canvas"><canvas ref={canvas} aria-label={t('docsReader.page')} /></div>
    {showText && <pre className="document-pdf-text">{text || t('docsReader.noText')}</pre>}
  </div>;
}
