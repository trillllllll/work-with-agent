import { useRef, useState, type DragEvent, type FocusEvent, type MutableRefObject } from 'react';
import { ImagePlus } from 'lucide-react';
import { toast } from 'sonner';
import { DescriptionEditor, type DescriptionHandle } from './DescriptionEditor.js';
import { ImageZoomDialog } from './ImageZoomDialog.js';
import { Button } from '@/components/ui/button.js';
import { api } from '@/lib/api.js';
import { imageMarkdown, isTaskImageSrc } from '@/lib/task-description.js';
import { compressTaskImage, fileToBase64, isRasterImage } from '@/lib/task-image.js';
import { cn } from '@/lib/utils.js';

export function TaskDescription({ taskId, value, readonly, fill, openDescription, onChange, onBlur, onComposeStart, onComposeEnd, onSave }: {
  taskId: string;
  value: string;
  readonly: boolean;
  fill: boolean;
  openDescription: MutableRefObject<() => void>;
  onChange: (description: string) => void;
  onBlur: (event: FocusEvent<HTMLElement>) => void;
  onComposeStart: () => void;
  onComposeEnd: () => void;
  onSave: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [zoomed, setZoomed] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<DescriptionHandle>(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  const addImages = async (files: File[]) => {
    const accepted = files.filter(isRasterImage);
    if (!accepted.length) {
      toast.error('只支持图片');
      return;
    }
    setBusy(true);
    try {
      let inserted = false;
      for (const file of accepted) {
        const compressed = await compressTaskImage(file);
        const attachmentBase64 = await fileToBase64(compressed.file);
        const saved = await api<{ url: string }>(`/api/tasks/${taskId}/images`, { method: 'POST', body: JSON.stringify({ attachmentBase64, mimeType: compressed.mimeType }) });
        editorRef.current?.insert(imageMarkdown(saved.url).text);
        inserted = true;
      }
      if (inserted) {
        await onSave();
        editorRef.current?.blur();
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '图片没有插入');
    } finally {
      setBusy(false);
    }
  };

  const takeImages = (event: DragEvent<HTMLElement>) => {
    if (readonly) return;
    const images = [...(event.dataTransfer?.files ?? [])].filter(isRasterImage);
    if (!images.length) return;
    event.preventDefault();
    void addImages(images);
  };

  return <div className={cn(fill && 'flex min-h-0 flex-1 flex-col')} onDragOver={(event) => { if (!readonly && [...event.dataTransfer.items].some((item) => item.kind === 'file')) event.preventDefault(); }} onDrop={takeImages}>
    {!readonly && <div data-description-tools data-task-editor className="mt-1 flex flex-wrap gap-1">
      <Button type="button" variant="ghost" size="sm" aria-label="插入图片" disabled={busy} onMouseDown={(event) => event.preventDefault()} onClick={() => fileRef.current?.click()}><ImagePlus />图片</Button>
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="sr-only" aria-label="选择图片" onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ''; if (files.length) void addImages(files); }} />
    </div>}
    {busy && <p className="mt-1 text-xs text-muted-foreground" role="status">正在压缩图片…</p>}
    <DescriptionEditor ref={editorRef} value={value} taskId={taskId} readonly={readonly} fill={fill} openDescription={openDescription} onChange={onChange} onBlur={onBlur} onComposeStart={onComposeStart} onComposeEnd={onComposeEnd} onPasteImages={(files) => { void addImages(files); }} onZoom={(src) => { if (!isTaskImageSrc(taskId, src)) return; editorRef.current?.blur(); setZoomed(src); }} />
    <ImageZoomDialog src={zoomed} onClose={() => setZoomed(null)} />
  </div>;
}
