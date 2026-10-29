import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Surface } from '@/components/ui/surface.js';
import { Button } from '@/components/ui/button.js';
import { DocumentSupplement } from '@/components/documents/DocumentSupplement.js';
import { TextDocumentEditor } from '@/components/documents/TextDocumentEditor.js';
import { useEditorRuntime } from '@/lib/task-editor-runtime.js';
import { loadResource } from '@/lib/documents/api.js';
import { ResourceReader } from '@/components/documents/ResourceReader.js';
import { RichDocumentEditor } from '@/components/documents/RichDocumentEditor.js';
import { DocumentExtractedText } from '@/components/documents/DocumentExtractedText.js';
import type { LibraryPreviewTarget } from './types.js';

/** Read-only picker adapter. Editing, organization and history live in the document workspace. */
export function LibraryPreview({ target, onTargetChange, onClose }: { target: LibraryPreviewTarget; onTargetChange: (target: LibraryPreviewTarget) => void; onClose: () => void; onOpenTask?: (taskId: string) => void }) {
  const { t } = useTranslation('library');
  const scope = useEditorRuntime()?.scopeKey;
  const query = useQuery({ queryKey: ['library', 'picker-resource', scope, target.materialId, target.revision], queryFn: () => loadResource(target.materialId, target.revision ?? undefined), enabled: Boolean(scope), retry: false });
  const [mode, setMode] = useState<'original' | 'extracted'>(target.chunkId ? 'extracted' : 'original');
  const resource = query.data;
  return <Surface as="aside" tone="card" className="library-panel library-preview library-sheet" data-testid="library-preview" aria-label={t('libraryPreview.previewLabel')}>
    <div className="library-preview-head"><div className="min-w-0"><h2 className="library-name truncate">{resource?.title ?? t('libraryPreview.loading')}</h2>{resource && <p className="library-meta" data-testid="library-preview-version">{t('libraryPreview.version', { revision: resource.revision })}</p>}</div><Button size="sm" variant="outline" onClick={onClose}>{t('shared.close')}</Button></div>
    {query.error && <p className="document-notice" role="alert">{query.error.message}</p>}
    <div className="library-preview-tabs"><Button size="sm" variant="tab" aria-pressed={mode === 'original'} onClick={() => setMode('original')}>{t('libraryPreview.original')}</Button><Button size="sm" variant="tab" aria-pressed={mode === 'extracted'} onClick={() => setMode('extracted')}>{t('libraryPreview.extractedText')}</Button>{target.revision != null && <Button size="sm" variant="ghost" onClick={() => onTargetChange({ materialId: target.materialId, revision: null, chunkId: null })}>{t('libraryPreview.viewLatest')}</Button>}</div>
    {resource && <div className="library-preview-block min-h-0 flex-1 overflow-auto">{mode === 'extracted' ? <DocumentExtractedText key={`${resource.id}:${resource.revision}`} resourceId={resource.id} revision={resource.revision} chunkId={target.chunkId} /> : resource.format === 'richdoc-v1' && typeof resource.content !== 'string' ? <RichDocumentEditor value={resource.content} sessionKey={`picker:${scope}:${resource.id}:${resource.revision}`} onChange={() => {}} readOnly /> : resource.format === 'text' || resource.format === 'markdown' ? <TextDocumentEditor value={typeof resource.content === 'string' ? resource.content : ''} format={resource.format} mode="read" readOnly references={resource.relativeReferences} fileName={resource.attachment?.fileName || resource.title} viewKey={`picker:${scope}:${resource.id}:${resource.revision}`} onChange={() => {}} onCompositionChange={() => {}} onUndo={() => {}} onRedo={() => {}} /> : <ResourceReader resource={resource} />}<DocumentSupplement content={resource.supplementalContent} viewKey={`picker:${scope}:${resource.id}:${resource.revision}`} /></div>}
  </Surface>;
}
