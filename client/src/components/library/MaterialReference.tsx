import { Button } from '@/components/ui/button.js';
import './library.css';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import { api } from '@/lib/api.js';
import { openDocument } from '@/components/documents/open.js';
import type { MaterialDetail } from './types.js';

export function MaterialReference({ materialId, fallback, onOpenTask }: { materialId: string; fallback: string; onOpenTask?: (taskId: string) => void }) {
  const { t } = useTranslation('library');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const detail = useQuery({ queryKey: ['library', 'material', materialId], queryFn: ({ signal }) => api<MaterialDetail>(`/api/v1/library/materials/${materialId}`, { signal }), retry: false });
  const title = detail.isError ? t('materialReference.unavailable') : detail.data?.title || fallback || t('shared.material');
  return <>
    <Button variant="plain" size="bare" ref={buttonRef} type="button" className="library-surface material-reference" data-testid={`material-reference-${materialId}`} onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }} onClick={(event) => { event.preventDefault(); event.stopPropagation(); openDocument({ resourceId: materialId }); }}>
      <FileText className="library-icon" aria-hidden />
      <span>{title}</span>
    </Button>
  </>;
}
