import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MarkdownView } from '../shared/MarkdownView.js';
import { MaterialReference } from '../library/MaterialReference.js';
import { Button } from '@/components/ui/button.js';
import { materialIdFromHref } from '../../lib/material-citation.js';
import { relativeAssetPath, type RelativeReference } from '../../lib/documents/markdown-assets.js';
import { loadResource } from '../../lib/documents/api.js';
import { isEditorRuntimeActive, useEditorRuntime } from '../../lib/task-editor-runtime.js';
import { readResourceBytes } from './readers/bytes.js';
import { openDocument } from './open.js';

function MappedImage({ reference, alt }: { reference: RelativeReference; alt: string }) {
  const { t } = useTranslation('library'); const scope = useEditorRuntime()?.scopeKey;
  const host = useRef<HTMLSpanElement>(null);
  const [src, setSrc] = useState(''); const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); let url: string | undefined; setSrc(''); setError(false);
    let observer: IntersectionObserver | undefined; let started = false;
    const active = () => Boolean(scope && isEditorRuntimeActive(scope) && !controller.signal.aborted);
    const load = () => {
      if (started || !active()) return;
      started = true; observer?.disconnect();
      void loadResource(reference.resourceId, reference.revision).then(async (resource) => {
        if (!active()) return;
        const mime = String(resource.attachment?.mimeType ?? '');
        if (!/^image\/(png|jpeg|webp|gif|avif|bmp)(;|$)/i.test(mime)) throw new Error('UNSUPPORTED_IMAGE');
        const bytes = await readResourceBytes(`/api/v1/library/resources/${encodeURIComponent(reference.resourceId)}/versions/${reference.revision}/original`, controller.signal);
        if (!active()) return;
        url = URL.createObjectURL(new Blob([bytes], { type: mime })); setSrc(url);
      }).catch(() => { if (active()) setError(true); });
    };
    if (scope && host.current) {
      if (typeof IntersectionObserver === 'undefined') load();
      else { observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) load(); }, { rootMargin: '400px' }); observer.observe(host.current); }
    }
    return () => { observer?.disconnect(); controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [scope, reference.resourceId, reference.revision]);
  return <span ref={host} className="document-mapped-image inline-block max-w-full">{src ? <img loading="lazy" src={src} alt={alt} className="max-w-full" /> : <span role="status">{t(error ? 'docsEditor.unavailable' : 'document.loading')}</span>}</span>;
}

export function DocumentMarkdown({ content, references = [], onResolveMissing }: { content: string; references?: RelativeReference[]; onResolveMissing?: (path: string) => void }) {
  const { t } = useTranslation('library'); const mapped = new Map(references.map((reference) => [reference.path, reference]));
  const missing = (path: string) => <span className="document-missing-reference" role="status">{t('document.missingRelative', { path })}{onResolveMissing && <Button size="sm" variant="ghost" onClick={() => onResolveMissing(path)}>{t('document.supplyRelative')}</Button>}</span>;
  return <MarkdownView content={content} diagrams allowMaterialLinks components={{
    img: ({ src, alt }) => {
      const path = relativeAssetPath(src ?? '');
      if (path) { const ref = mapped.get(path); return ref ? <MappedImage reference={ref} alt={alt ?? ''} /> : missing(path); }
      return <img src={src} alt={alt} loading="lazy" className="max-w-full" />;
    },
    a: ({ children, href }) => {
      const path = relativeAssetPath(href ?? '');
      if (path) { const ref = mapped.get(path); return ref ? <Button variant="link" size="bare" onClick={() => openDocument({ resourceId: ref.resourceId, revision: ref.revision })}>{children}</Button> : missing(path); }
      const id = materialIdFromHref(href ?? '');
      return id ? <MaterialReference materialId={id} fallback={String(children)} /> : <a href={href} target="_blank" rel="noreferrer" className="text-brand-link underline underline-offset-2">{children}</a>;
    },
  }} />;
}
