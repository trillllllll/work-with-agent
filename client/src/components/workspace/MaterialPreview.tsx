import { useEffect, useState } from 'react';
import { MarkdownView } from '@/components/chat/MarkdownView.js';
import { attachmentPreviewKind } from '@/lib/attachment-title.js';

type PreviewBody =
  | { status: 'idle' | 'loading' | 'unsupported' | 'error' | 'empty' }
  | { status: 'markdown' | 'text' | 'html'; text: string }
  | { status: 'pdf' | 'image'; url: string };

function imageType(fileName: string) {
  const extension = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase();
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'gif') return 'image/gif';
  if (extension === 'webp') return 'image/webp';
  return 'image/png';
}

export function MaterialPreview({ materialId, revision, kind, content, fileName, hasAttachment }: { materialId: string; revision: number; kind: string; content?: string; fileName?: string | null; hasAttachment?: boolean }) {
  const [body, setBody] = useState<PreviewBody>({ status: 'idle' });
  useEffect(() => {
    if (!hasAttachment) {
      setBody({ status: 'idle' });
      return;
    }
    const previewKind = attachmentPreviewKind(fileName);
    if (previewKind === 'unsupported') {
      setBody({ status: 'unsupported' });
      return;
    }
    const controller = new AbortController();
    let objectUrl = '';
    let cancelled = false;
    setBody({ status: 'loading' });
    const finish = (next: PreviewBody) => {
      if (cancelled) {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        return;
      }
      setBody(next);
    };
    (async () => {
      const response = await fetch(`/api/v1/knowledge/materials/${materialId}/versions/${revision}/attachment`, { credentials: 'include', signal: controller.signal });
      if (!response.ok) throw new Error(String(response.status));
      const bytes = await response.arrayBuffer();
      if (previewKind === 'markdown' || previewKind === 'text' || previewKind === 'html') {
        const text = new TextDecoder().decode(bytes);
        finish(text.trim() ? { status: previewKind, text } : { status: 'empty' });
        return;
      }
      if (previewKind === 'docx') {
        const { default: mammoth } = await import('mammoth');
        const result = await mammoth.convertToHtml({ arrayBuffer: bytes });
        finish(result.value.trim() ? { status: 'html', text: result.value } : { status: 'empty' });
        return;
      }
      objectUrl = URL.createObjectURL(new Blob([bytes], { type: previewKind === 'pdf' ? 'application/pdf' : imageType(fileName ?? '') }));
      finish({ status: previewKind, url: objectUrl });
    })().catch((error: unknown) => {
      if (cancelled || (error instanceof DOMException && error.name === 'AbortError')) return;
      finish({ status: 'error' });
    });
    return () => {
      cancelled = true;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [fileName, hasAttachment, materialId, revision]);

  const written = content?.trim() ?? '';
  const frame = 'absolute inset-0 h-full w-full rounded-lg border bg-white';
  return <div className="flex h-full min-h-0 flex-col gap-3">
    {written && (kind === 'markdown' ? <div className="min-h-0 flex-1 overflow-auto"><MarkdownView content={content ?? ''} /></div> : <p className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words text-sm">{content}</p>)}
    {body.status === 'loading' && <p className="text-sm text-muted-foreground">正在读取原件…</p>}
    {body.status === 'error' && <p className="text-sm text-destructive">无法预览，可以下载原件。</p>}
    {body.status === 'unsupported' && <p className="text-sm text-muted-foreground">这里不能排版预览，可以下载原件。</p>}
    {body.status === 'empty' && <p className="text-sm text-muted-foreground">这份文档没有可显示的正文。</p>}
    {body.status === 'markdown' && <div className="min-h-0 flex-1 overflow-auto"><MarkdownView content={body.text} /></div>}
    {body.status === 'text' && <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words font-mono text-sm">{body.text}</pre>}
    {body.status === 'html' && <div className="relative min-h-0 flex-1"><iframe title="材料正文" sandbox="" srcDoc={body.text} className={frame} /></div>}
    {body.status === 'pdf' && <div className="relative min-h-0 flex-1"><iframe title="材料正文" src={body.url} className={frame} /></div>}
    {body.status === 'image' && <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto"><img alt={fileName || '附件预览'} src={body.url} className="max-h-full max-w-full object-contain" /></div>}
  </div>;
}
