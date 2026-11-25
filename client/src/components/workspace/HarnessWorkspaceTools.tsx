import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { File as FileIcon, FolderOpen, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api.js';
import { json } from '@/lib/platform.js';
import { Button } from '@/components/ui/button.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.js';
import { Input } from '@/components/ui/input.js';
import { Surface } from '@/components/ui/surface.js';
import { compressHarnessImage } from '@/lib/harness-image.js';
import { keepHarnessImage } from '@/lib/harness-image-drafts.js';
import { fileToBase64 } from '@/lib/task-image.js';
import { HARNESS_LEGACY_IMAGE_LIMIT, HARNESS_TEXT_FILE_LIMIT, HARNESS_TEXT_LIMIT, type HarnessFilesPage, type HarnessInputAttachment } from '../../../../server/src/node-agent/harness-protocol.js';

type FileIssue = 'largeImageUpdate' | 'imageStillTooLarge' | 'imageFormat' | 'textSize' | 'textEncoding';
class AttachmentError extends Error {
  constructor(readonly issue: FileIssue) { super(issue); }
}

async function attachmentOf(file: File, imageLimit: number): Promise<HarnessInputAttachment> {
  if (file.type === 'image/png' || file.type === 'image/jpeg') {
    if (file.size > imageLimit && imageLimit === HARNESS_LEGACY_IMAGE_LIMIT) throw new AttachmentError('largeImageUpdate');
    const image = file.size > imageLimit ? await compressHarnessImage(file, imageLimit) : file;
    if (!image) throw new AttachmentError('imageStillTooLarge');
    const mediaType = image.type === 'image/png' ? 'image/png' : 'image/jpeg';
    return { kind: 'imageFile', name: image.name.slice(0, 255), mediaType, content: await fileToBase64(image) };
  }
  if (file.type.startsWith('image/')) throw new AttachmentError('imageFormat');
  if (file.size > HARNESS_TEXT_FILE_LIMIT) throw new AttachmentError('textSize');
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); }
  catch { throw new AttachmentError('textEncoding'); }
  if (content.includes('\0')) throw new AttachmentError('textEncoding');
  if (content.length > HARNESS_TEXT_LIMIT) throw new AttachmentError('textSize');
  return { kind: 'textFile', name: file.name.slice(0, 255), content };
}

export type HarnessAttachmentNotice = { text: string; error?: true };

export function HarnessWorkspaceTools({ endpoint, disabled, capacity, imageLimit, processing, onProcessing, onNotice,
  requested, clearRequest, attach, compact, configurePlan, running }: {
  endpoint: string;
  disabled: boolean;
  capacity: number;
  imageLimit: number;
  processing: boolean;
  onProcessing: (processing: boolean) => void;
  onNotice: (notice: HarnessAttachmentNotice | null) => void;
  requested: 'files' | 'commands' | null;
  clearRequest: () => void;
  attach: (attachment: HarnessInputAttachment) => void;
  compact?: () => void;
  configurePlan?: () => void;
  running: boolean;
}) {
  const { t } = useTranslation('workspace');
  const fileInput = useRef<HTMLInputElement>(null);
  const [section, setSection] = useState<'files' | 'commands' | null>(null);
  const [folder, setFolder] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  async function addFile(file: File) {
    if (disabled || !capacity || processing) return;
    onProcessing(true);
    onNotice(imageLimit > HARNESS_LEGACY_IMAGE_LIMIT && file.type.startsWith('image/') && file.size > imageLimit
      ? { text: t('harness.files.compressing') } : null);
    try {
      const attachment = await attachmentOf(file, imageLimit);
      if (attachment.kind === 'imageFile') {
        // The image can still be sent from this tab if browser draft storage is unavailable.
        await keepHarnessImage(attachment).catch(() => undefined);
      }
      attach(attachment);
      onNotice(null);
    } catch (error) {
      const issue = error instanceof AttachmentError ? error.issue : 'readFailed';
      onNotice({ error: true, text: t('harness.files.' + issue, { max: imageLimit / (1024 * 1024) }) });
    } finally { onProcessing(false); }
  }
  const active = requested ?? section;
  const browsing = active === 'files';
  const files = useQuery({
    queryKey: ['harness-files', endpoint, selected ?? folder, selected !== null], enabled: browsing,
    queryFn: ({ signal }) => api<HarnessFilesPage>(endpoint + '/files', { method: 'POST', body: json({ path: selected ?? folder, preview: selected !== null }), signal }),
    staleTime: 4_000, retry: false,
  });
  function navigate(path: string) { setSelected(null); setFilter(''); setFolder(path); }
  function close() { setSelected(null); setSection(null); clearRequest(); }
  return <>
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button type="button" variant="ghost" size="icon" aria-label={t('harness.files.tools')}><Plus /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem disabled={disabled || !capacity || processing} onSelect={() => fileInput.current?.click()}>{t('harness.files.upload')}</DropdownMenuItem>
        <DropdownMenuItem disabled={disabled} onSelect={() => setSection('files')}>{t('harness.files.title')}</DropdownMenuItem>
        <DropdownMenuItem disabled={disabled} onSelect={() => setSection('commands')}>{t('harness.files.commands')}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <Input ref={fileInput} type="file" className="hidden" aria-label={t('harness.files.upload')} accept="image/png,image/jpeg,text/*,.json,.md,.yaml,.csv"
      onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (file) void addFile(file);
      }} />
    <Dialog open={browsing} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent className="flex max-h-[85dvh] flex-col overflow-hidden">
        <DialogHeader><DialogTitle>{t('harness.files.title')}</DialogTitle></DialogHeader>
        <div className="glass-scrollbar min-h-0 space-y-3 overflow-y-auto">
          {(folder || selected) && <div className="flex min-w-0 items-center gap-2">
            <Button type="button" variant="outline" size="sm" className="min-h-11"
              onClick={() => selected ? setSelected(null) : navigate(folder.split('/').slice(0, -1).join('/'))}>{t('harness.parentFolder')}</Button>
            <code className="truncate text-xs" title={selected ?? folder}>{selected ?? folder}</code>
          </div>}
          {files.isLoading && <p role="status" className="text-sm text-muted-foreground">{t('harness.loading')}</p>}
          {files.error && <p role="alert" className="text-sm text-destructive">{files.error.message}</p>}
          {files.data?.kind === 'directory' && <>
            <Input value={filter} onChange={(event) => setFilter(event.target.value)} aria-label={t('harness.files.search')} placeholder={t('harness.files.search')} />
            <Surface tone="sheet" className="workspace-rows">
              {files.data.entries.filter((entry) => entry.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase())).map((entry) => <Button key={entry.path}
                type="button" variant="row" size="bare" className="workspace-row flex min-h-11 w-full items-center gap-2 px-2 py-2 text-left"
                onClick={() => entry.directory ? navigate(entry.path) : setSelected(entry.path)}>
                {entry.directory ? <FolderOpen /> : <FileIcon />}<span className="min-w-0 truncate">{entry.name}</span>
              </Button>)}
            </Surface>
            {files.data.limited && <p className="text-xs text-muted-foreground">{t('harness.files.limited')}</p>}
          </>}
          {files.data?.kind === 'file' && (files.data.mediaType === 'text/plain'
            ? <pre className="min-w-0 whitespace-pre-wrap break-words text-xs">{files.data.content}</pre>
            : <img className="max-h-80 w-auto max-w-full object-contain" alt={files.data.path} src={'data:' + files.data.mediaType + ';base64,' + files.data.content} />)}
        </div>
        {selected && files.data?.kind === 'file' && <Button type="button" className="min-h-11 self-end" disabled={!capacity || disabled || processing} onClick={() => {
          attach({ kind: 'projectFile', path: selected, name: selected.slice(selected.lastIndexOf('/') + 1) });
          close();
        }}>{t('harness.files.attach')}</Button>}
      </DialogContent>
    </Dialog>
    <Dialog open={active === 'commands'} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('harness.files.commands')}</DialogTitle></DialogHeader>
        <Surface tone="sheet" className="workspace-rows">
          {compact && <Button type="button" variant="row" size="bare" className="workspace-row flex min-h-11 w-full justify-start px-2" disabled={running}
            onClick={() => { close(); compact(); }}>{t('harness.context.compact')}</Button>}
          {configurePlan && <Button type="button" variant="row" size="bare" className="workspace-row flex min-h-11 w-full justify-start px-2" disabled={running}
            onClick={() => { close(); configurePlan(); }}>{t('harness.settings.planMode')}</Button>}
        </Surface>
      </DialogContent>
    </Dialog>
  </>;
}
