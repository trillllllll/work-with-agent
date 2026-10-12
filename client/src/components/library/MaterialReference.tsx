import './library.css';
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import { api } from '@/lib/api.js';
import { LibraryPreview } from './LibraryPreview.js';
import type { MaterialDetail } from './types.js';

export function MaterialReference({ materialId, fallback }: { materialId: string; fallback: string }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const detail = useQuery({ queryKey: ['library', 'material', materialId], queryFn: ({ signal }) => api<MaterialDetail>(`/api/v1/library/materials/${materialId}`, { signal }), retry: false });
  const title = detail.isError ? '资料不可访问' : detail.data?.title || fallback || '资料';
  const close = () => { setOpen(false); buttonRef.current?.focus(); };
  return <>
    <button ref={buttonRef} type="button" className="library-surface material-reference" data-testid={`material-reference-${materialId}`} onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }} onClick={(event) => { event.preventDefault(); event.stopPropagation(); setOpen(true); }}>
      <FileText className="library-icon" aria-hidden />
      <span>{title}</span>
    </button>
    {open && createPortal(<div className="library-preview-host library-surface"><LibraryPreview id={materialId} onClose={close} /></div>, document.body)}
  </>;
}
