import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { BodyText } from '@/components/shared/BodyText.js';
import type { ResourceDocument } from '@/lib/documents/types.js';
import { useEditorRuntime } from '@/lib/task-editor-runtime.js';
import { verifyOfficeArchiveBudget } from './readers/archive-budget.js';
import './resource-reader.css';
import { readResourceBytes, readerByteBudget } from './readers/bytes.js';
import { readExtractedText } from './readers/extracted-text.js';

const PdfReader = lazy(() => import('./readers/PdfReader.js'));
const WorkbookReader = lazy(() => import('./readers/WorkbookReader.js'));
export function resourceOriginalUrl(resource: Pick<ResourceDocument, 'id' | 'revision'>) { return `/api/v1/library/resources/${encodeURIComponent(resource.id)}/versions/${resource.revision}/original`; }
export function saveDocumentBlob(blob: Blob, name: string) { const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }

type Preview = { kind: 'image'; url: string } | { kind: 'docx'; html: string } | { kind: 'pdf' | 'xlsx'; bytes: ArrayBuffer } | { kind: 'unsupported' };
export function ResourceReader({ resource }: { resource: ResourceDocument }) {
  const { t } = useTranslation('library'); const runtime = useEditorRuntime(); const scopeKey = runtime?.scopeKey;
  const [preview, setPreview] = useState<Preview | null>(null); const [error, setError] = useState(''); const [zoom, setZoom] = useState(1);
  const [extracted, setExtracted] = useState<string | null>(null);
  const extraction = useRef<AbortController | null>(null);
  const readerKey = JSON.stringify([scopeKey, resource.id, resource.revision]);
  const currentReader = useRef(readerKey); currentReader.current = readerKey;
  const filename = resource.attachment?.fileName || resource.title;
  const mime = resource.attachment?.mimeType || '';
  const extension = filename.split('.').pop()?.toLowerCase();
  useEffect(() => {
    if (!scopeKey) return;
    const abort = new AbortController(); let objectUrl: string | null = null;
    extraction.current?.abort();
    setPreview(null); setError(''); setExtracted(null); setZoom(1);
    const run = async () => {
      const kind = /^image\/(png|jpeg|webp|gif|avif|bmp)$/.test(mime) || ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp'].includes(extension ?? '') ? 'image'
        : mime === 'application/pdf' || extension === 'pdf' ? 'pdf' : extension === 'docx' ? 'docx' : extension === 'xlsx' ? 'xlsx' : 'unsupported';
      if (kind === 'unsupported') { setPreview({ kind }); return; }
      const bytes = await readResourceBytes(resourceOriginalUrl(resource), abort.signal, kind === 'xlsx' || kind === 'docx' ? 10 * 1024 * 1024 : readerByteBudget);
      if (abort.signal.aborted) return;
      if (kind === 'xlsx' || kind === 'docx') await verifyOfficeArchiveBudget(bytes, abort.signal);
      if (kind === 'image') { objectUrl = URL.createObjectURL(new Blob([bytes], { type: mime || `image/${extension === 'jpg' ? 'jpeg' : extension}` })); setPreview({ kind, url: objectUrl }); }
      else if (kind === 'docx') {
        const { default: mammoth } = await import('mammoth');
        const result = await mammoth.convertToHtml({ arrayBuffer: bytes });
        // The iframe is sandboxed and a CSP blocks network and executable content.
        if (!abort.signal.aborted) setPreview({ kind, html: `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>body{font:16px/1.7 system-ui;padding:24px;overflow-wrap:anywhere}img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #aaa;padding:6px}</style>${result.value}` });
      } else setPreview({ kind, bytes });
    };
    void run().catch((failure: unknown) => { if (!abort.signal.aborted) setError(failure instanceof Error && failure.message === 'READER_BUDGET_EXCEEDED' ? t('docsReader.budget') : t('docsReader.failed')); });
    return () => { abort.abort(); extraction.current?.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [scopeKey, resource.id, resource.revision, mime, extension]);
  const download = () => { const link = document.createElement('a'); link.href = resourceOriginalUrl(resource); link.download = filename; link.click(); };
  const loadExtracted = async () => {
    extraction.current?.abort(); const controller = new AbortController(); extraction.current = controller;
    try { const text = await readExtractedText(resource.id, resource.revision, controller.signal, t('docsReader.excerpt')); if (readerKey === currentReader.current && extraction.current === controller && !controller.signal.aborted) setExtracted(text); }
    catch { if (readerKey === currentReader.current && !controller.signal.aborted) setError(t('docsReader.failed')); }
  };
  return <div className="document-file-reader">
    <div className="document-reader-toolbar">
      <Button variant="outline" size="sm" onClick={download}>{t('docsReader.download')}</Button>
      <Button variant="ghost" size="sm" onClick={() => { void loadExtracted(); }}>{t('docsReader.extracted')}</Button>
      {preview?.kind === 'image' && <><Button variant="ghost" size="sm" onClick={() => setZoom(1)}>{t('docsReader.fit')}</Button><Input aria-label={t('docsReader.zoom')} type="range" min="0.25" max="4" step="0.25" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} /></>}
    </div>
    {error && <p role="alert">{error}</p>}
    {!preview && !error && <p role="status">{t('shared.loadingMaterials')}</p>}
    {preview?.kind === 'unsupported' && <p>{t('docsReader.unsupported')}</p>}
    {preview?.kind === 'image' && <div className="document-image-reader"><img src={preview.url} alt={filename} style={{ maxWidth: zoom === 1 ? '100%' : 'none', width: zoom === 1 ? undefined : `${zoom * 100}%` }} /></div>}
    {preview?.kind === 'docx' && <><p>{t('docsReader.docxNote')}</p><iframe className="document-office-frame" title={filename} sandbox="" srcDoc={preview.html} /></>}
    <Suspense fallback={<p role="status">{t('shared.loadingMaterials')}</p>}>
      {preview?.kind === 'pdf' && <PdfReader bytes={preview.bytes} positionKey={`${scopeKey}:${resource.id}:${resource.revision}`} />}
      {preview?.kind === 'xlsx' && <WorkbookReader bytes={preview.bytes} />}
    </Suspense>
    {extracted !== null && <section><h3>{t('docsReader.extracted')}</h3><BodyText text={extracted} format="plain" /></section>}
    {typeof resource.content === 'string' && resource.content && <section><h3>{t('docsReader.legacyNotes')}</h3><BodyText text={resource.content} format="plain" /></section>}
  </div>;
}
