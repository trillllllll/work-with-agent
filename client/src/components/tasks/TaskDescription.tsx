import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { ImagePlus } from 'lucide-react';
import { toast } from 'sonner';
import { DescriptionEditor, removeTaskUploadFromEditor, resolveTaskUploadOnEditor, type DescriptionHandle } from './DescriptionEditor.js';
import { ImageZoomDialog } from './ImageZoomDialog.js';
import { Button } from '@/components/ui/button.js';
import { cancelUpload, enqueueTaskUpload, listUploads, markUpload, runTaskUpload } from '@/lib/task-editor-runtime.js';
import { isTaskImageSrc } from '@/lib/task-description.js';
import { isRasterImage } from '@/lib/task-image.js';
import { cn } from '@/lib/utils.js';

export function TaskDescription({ taskId, value, readonly, fill, openDescription, onEdit, onComposeStart, onComposeEnd, onOpenLinkedTask }: {
  taskId: string;
  value: string;
  readonly: boolean;
  fill: boolean;
  openDescription: MutableRefObject<() => void>;
  onEdit: (description: string) => void;
  onComposeStart: () => void;
  onComposeEnd: () => void;
  onOpenLinkedTask?: (taskId: string) => void;
}) {
  const [zoomed, setZoomed] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<DescriptionHandle>(null);
  const taskIdRef = useRef(taskId);
  taskIdRef.current = taskId;

  // 上传取消事件来自编辑器装饰的取消按钮。
  useEffect(() => {
    const onCancel = (event: Event) => {
      const uploadId = (event as CustomEvent<{ uploadId: string }>).detail?.uploadId;
      if (!uploadId) return;
      const entry = listUploads().find((upload) => upload.uploadId === uploadId);
      if (!entry || entry.taskId !== taskIdRef.current) return;
      cancelUpload(uploadId);
      removeTaskUploadFromEditor(taskIdRef.current, uploadId);
    };
    window.addEventListener('wwa-cancel-upload', onCancel);
    return () => window.removeEventListener('wwa-cancel-upload', onCancel);
  }, []);

  const addImages = (files: File[]) => {
    const accepted = files.filter(isRasterImage);
    if (!accepted.length) {
      toast.error('只支持图片');
      return;
    }
    for (const file of accepted) {
      // 捕获当前 taskId；上传完成后只操作这个任务的文档。
      const capturedTask = taskIdRef.current;
      const uploadId = enqueueTaskUpload(capturedTask, file);
      editorRef.current?.addUpload(uploadId, file.name || '图片');
      void runTaskUpload(capturedTask, uploadId, file)
        .then((url) => {
          // 装饰被用户删除时不再插入；详情已切换时不插入新任务。
          resolveTaskUploadOnEditor(capturedTask, uploadId, url);
        })
        .catch((error) => {
          markUpload(uploadId, { state: 'failed', error: error instanceof Error ? error.message : '上传失败' });
          removeTaskUploadFromEditor(capturedTask, uploadId);
          toast.error(error instanceof Error ? error.message : '图片没有插入');
        });
    }
  };

  return <div className={cn(fill && 'flex min-h-0 flex-1 flex-col')} onDragOver={(event) => { if (!readonly && [...event.dataTransfer.items].some((item) => item.kind === 'file')) event.preventDefault(); }} onDrop={(event) => {
    // 编辑器已处理的拖放带 defaultPrevented。
    if (readonly || event.defaultPrevented) return;
    const images = [...(event.dataTransfer?.files ?? [])].filter(isRasterImage);
    if (!images.length) return;
    event.preventDefault();
    event.stopPropagation();
    addImages(images);
  }}>
    {!readonly && <div data-description-tools data-task-editor className="mt-1 flex flex-wrap gap-1">
      <Button type="button" variant="ghost" size="sm" aria-label="插入图片" onMouseDown={(event) => event.preventDefault()} onClick={() => fileRef.current?.click()}><ImagePlus />图片</Button>
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="sr-only" aria-label="选择图片" onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ''; if (files.length) addImages(files); }} />
    </div>}
    <DescriptionEditor ref={editorRef} value={value} taskId={taskId} readonly={readonly} fill={fill} openDescription={openDescription} onEdit={onEdit}
      onComposeStart={onComposeStart} onComposeEnd={onComposeEnd}
      onPasteImages={addImages}
      onZoom={(src) => { if (!isTaskImageSrc(taskId, src)) return; editorRef.current?.blur(); setZoomed(src); }}
      onOpenLinkedTask={onOpenLinkedTask} />
    <ImageZoomDialog src={zoomed} onClose={() => setZoomed(null)} />
  </div>;
}
