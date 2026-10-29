import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.js';
import { loadResource } from '@/lib/documents/api.js';
import { useEditorRuntime } from '@/lib/task-editor-runtime.js';
import { openDocument } from './open.js';

type UsedResource = { resourceId: string; revision: number; accessible: boolean };
export function DocumentResources({ resourceId, revision }: { resourceId: string; revision: number }) {
  const { t } = useTranslation('library');
  const scope = useEditorRuntime()?.scopeKey;
  const [page, setPage] = useState(0);
  const document = useQuery({ queryKey: ['library', 'document-resources', scope, resourceId, revision], queryFn: () => loadResource(resourceId, revision), enabled: Boolean(scope && revision), retry: false });
  const seen = new Set<string>();
  const resources = (document.data?.references ?? []).flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const value = entry as Partial<UsedResource>;
    if (typeof value.resourceId !== 'string' || !Number.isInteger(value.revision)) return [];
    const key = `${value.resourceId}:${value.revision}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ resourceId: value.resourceId, revision: value.revision!, accessible: value.accessible === true }];
  });
  const cursor = Math.min(page * 40, Math.max(0, Math.ceil(resources.length / 40) - 1) * 40);
  return <div className="document-info-section" data-testid="document-used-files">
    {document.error && <p role="alert">{document.error.message}</p>}
    {document.isLoading && <p role="status">{t('document.loading')}</p>}
    {document.data && !resources.length && <p className="library-meta">{t('document.noUsedFiles')}</p>}
    {resources.slice(cursor, cursor + 40).map((reference) => <UsedResourceRow key={`${reference.resourceId}:${reference.revision}`} reference={reference} scope={scope} />)}
    {resources.length > 40 && <div className="flex gap-2"><Button size="sm" variant="ghost" disabled={cursor === 0} onClick={() => setPage(Math.max(0, page - 1))}>{t('shared.previousPage')}</Button><Button size="sm" variant="ghost" disabled={cursor + 40 >= resources.length} onClick={() => setPage(page + 1)}>{t('shared.nextPage')}</Button></div>}
  </div>;
}

function UsedResourceRow({ reference, scope }: { reference: UsedResource; scope?: string }) {
  const { t } = useTranslation('library');
  const resource = useQuery({ queryKey: ['library', 'used-resource', scope, reference.resourceId, reference.revision], queryFn: () => loadResource(reference.resourceId, reference.revision), enabled: Boolean(scope && reference.accessible), retry: false });
  if (!reference.accessible || resource.isError) return <p className="library-meta">{t('docsEditor.unavailable')}</p>;
  return <Button size="sm" variant="link" className="h-auto justify-start whitespace-normal text-left" disabled={!resource.data} onClick={() => openDocument({ resourceId: reference.resourceId, revision: reference.revision })}><span>{resource.data?.title ?? t('document.loading')}</span><span className="ml-2 library-meta">v{reference.revision}</span></Button>;
}
