import './library.css';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import { api } from '@/lib/api.js';
import { LibraryPreview } from './LibraryPreview.js';
import type { LibraryPreviewTarget, MaterialDetail } from './types.js';

export function MaterialReference({ materialId, fallback, onOpenTask }: { materialId: string; fallback: string; onOpenTask?: (taskId: string) => void }) {
  const { t } = useTranslation('library');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [target, setTarget] = useState<LibraryPreviewTarget | null>(null);
  const detail = useQuery({ queryKey: ['library', 'material', materialId], queryFn: ({ signal }) => api<MaterialDetail>(`/api/v1/library/materials/${materialId}`, { signal }), retry: false });
  const title = detail.isError ? t('materialReference.unavailable') : detail.data?.title || fallback || t('shared.material');
  const close = () => { setTarget(null); buttonRef.current?.focus(); };
  return <>
    <button ref={buttonRef} type="button" className="library-surface material-reference" data-testid={`material-reference-${materialId}`} onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }} onClick={(event) => { event.preventDefault(); event.stopPropagation(); setTarget({ materialId, revision: null, chunkId: null }); }}>
      <FileText className="library-icon" aria-hidden />
      <span>{title}</span>
    </button>
    {target && createPortal(<div className="library-preview-host library-surface"><LibraryPreview target={target} onTargetChange={setTarget} onClose={close} onOpenTask={onOpenTask} /></div>, document.body)}
  </>;
}
