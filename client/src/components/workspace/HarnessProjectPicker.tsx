import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronLeft, ChevronRight, Folder, FolderOpen, Folders, Laptop, List } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog.js';
import { Input } from '@/components/ui/input.js';
import { Label } from '@/components/ui/label.js';
import { Surface } from '@/components/ui/surface.js';
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog.js';
import type { DirectoryPage } from '../../../../server/src/node-agent/directory-protocol.js';

export type HarnessProject = { id: string; nodeId: string; path: string; projectName: string; computerName: string };
export type ProjectComputer = { id: string; name: string; online: boolean; canBrowse?: boolean };
type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: HarnessProject[];
  computers: ProjectComputer[];
  value?: string;
  onChange: (project: HarnessProject | null) => void;
  browse: (computerId: string, path: string | null) => Promise<DirectoryPage>;
  selectDirectory: (computerId: string, path: string) => Promise<HarnessProject>;
  loading?: boolean;
  error?: string;
  directoryHint?: string;
};
const row = 'workspace-row flex min-h-11 w-full items-center gap-3 px-2 py-2 text-left';

export function ChatProjectButton({ name, open }: { name: string; open: () => void }) {
  const { t } = useTranslation('workspace');
  return <Button type="button" variant="ghost" size="sm" className="min-h-11 min-w-0 max-w-full justify-start gap-1.5 px-2"
    aria-haspopup="dialog" aria-label={t('harness.chatProject', { project: name })} onClick={open}>
    <FolderOpen className="size-3.5" /><span className="truncate">{name}</span><ChevronDown className="size-3" />
  </Button>;
}

export function HarnessProjectPicker({ open, onOpenChange, projects, computers, value, onChange, browse, selectDirectory, loading, error, directoryHint }: Props) {
  const { t } = useTranslation('workspace');
  const selected = projects.find((project) => project.id === value);
  const [computer, setComputer] = useState<ProjectComputer | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => { if (!open) setComputer(null); }, [open]);
  function choose(project: HarnessProject | null) {
    onChange(project);
    onOpenChange(false);
  }
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogTrigger asChild>
      <Button type="button" variant="outline" className="min-h-11 w-full justify-start" aria-label={t('harness.chooseProject')}>
        <FolderOpen /><span>{t('harness.chooseProject')}</span>
        <span className="ml-auto min-w-0 truncate text-xs text-muted-foreground">{selected?.projectName ?? t('harness.allProjects')}</span><ChevronRight />
      </Button>
    </DialogTrigger>
    <DialogContent className="flex max-h-[85dvh] flex-col overflow-hidden"
      onOpenAutoFocus={() => { opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
      onCloseAutoFocus={(event) => {
        if (opener.current && opener.current !== document.body && opener.current.getClientRects().length) {
          event.preventDefault();
          opener.current.focus({ preventScroll: true });
        }
      }}>
      <DialogHeader>
        <DialogTitle>{computer?.name ?? t('harness.chooseProject')}</DialogTitle>
        <DialogDescription>{computer ? directoryHint ?? t('harness.directoryHint') : t('harness.projectPickerHint')}</DialogDescription>
      </DialogHeader>
      {computer ? <ComputerFolders key={computer.id} computer={computer} browse={browse} selectDirectory={selectDirectory}
        back={() => setComputer(null)} onChoose={choose} /> : <div className="glass-scrollbar min-h-0 space-y-4 overflow-y-auto">
        <div className="space-y-1.5">
          <h3 className="text-xs font-medium text-muted-foreground">{t('harness.browseComputer')}</h3>
          <Surface tone="sheet" className="workspace-rows">
            {computers.map((node) => <Button key={node.id} type="button" variant="row" size="bare" className={row}
              disabled={!node.online || !node.canBrowse} onClick={() => setComputer(node)}>
              <Laptop className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 break-words">{node.name}</span>
              {!node.online ? <span className="text-xs">{t('harness.status.offline')}</span>
                : !node.canBrowse ? <span className="text-xs">{t('harness.updateComputer')}</span> : <ChevronRight className="size-4" />}
            </Button>)}
            {!computers.length && <p className="px-2 py-3 text-sm text-muted-foreground">{t(loading ? 'harness.loading' : 'harness.noPairedComputer')}</p>}
          </Surface>
        </div>
        <div className="space-y-1.5">
          <h3 className="text-xs font-medium text-muted-foreground">{t('harness.savedProjects')}</h3>
          <Surface tone="sheet" className="workspace-rows">
            <Button type="button" variant="row" size="bare" className={row} onClick={() => choose(null)}>
              <List className="size-4 text-muted-foreground" />{t('harness.allProjects')}{!value && <Check className="ml-auto size-4 text-brand-link" />}
            </Button>
            {projects.map((item) => <Button key={item.id} type="button" variant="row" size="bare" className={row}
              onClick={() => choose(item)} data-selected={item.id === value || undefined}>
              <Folder className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block break-words text-sm font-medium">{item.projectName}</span>
                <span className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">{item.computerName} · {item.path}</span>
              </span>
              {item.id === value && <Check className="size-4 text-brand-link" />}
            </Button>)}
          </Surface>
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </div>}
    </DialogContent>
  </Dialog>;
}

function ComputerFolders({ computer, browse, selectDirectory, back, onChoose }: Pick<Props, 'browse' | 'selectDirectory'> & {
  computer: ProjectComputer; back: () => void; onChoose: (project: HarnessProject) => void;
}) {
  const { t } = useTranslation('workspace');
  const inputId = useId();
  const [page, setPage] = useState<DirectoryPage | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [confirming, setConfirming] = useState(false);
  const seq = useRef(0);
  const lastPath = useRef<string | null>(null);
  async function load(path: string | null) {
    const request = ++seq.current;
    lastPath.current = path;
    setBusy(true); setFailure('');
    try {
      const next = await browse(computer.id, path);
      if (request === seq.current) { setPage(next); setInput(next.directory?.path ?? ''); }
    } catch (err) { if (request === seq.current) setFailure(err instanceof Error ? err.message : t('harness.requestFailed')); }
    finally { if (request === seq.current) setBusy(false); }
  }
  useEffect(() => {
    void load(null);
    return () => { seq.current++; };
  }, [computer.id]);
  async function choose() {
    if (busy || !page?.directory || input !== page.directory.path) return;
    const request = ++seq.current;
    setBusy(true); setFailure('');
    try {
      const location = await selectDirectory(computer.id, page.directory.path);
      if (request === seq.current) onChoose(location);
    } catch (err) { if (request === seq.current) setFailure(err instanceof Error ? err.message : t('harness.requestFailed')); }
    finally { if (request === seq.current) setBusy(false); }
  }
  return <>
    <form className="space-y-1.5" onSubmit={(event) => { event.preventDefault(); if (!busy && input.trim()) void load(input.trim()); }}>
      <Label htmlFor={inputId}>{t('harness.folderPath')}</Label>
      <div className="flex min-w-0 gap-2">
        <Input id={inputId} className="min-h-11 min-w-0 flex-1 text-base" value={input} placeholder={t('harness.absolutePath')}
          autoCapitalize="none" spellCheck={false} onChange={(event) => setInput(event.target.value)} />
        <Button type="submit" variant="outline" className="min-h-11" disabled={busy || !input.trim()}>{t('harness.goToPath')}</Button>
      </div>
    </form>
    <div className="glass-scrollbar min-h-0 flex-1 overflow-y-auto">
      <Surface tone="sheet" className="workspace-rows">
        <Button type="button" variant="row" size="bare" className={row} disabled={busy}
          onClick={() => page?.directory ? void load(page.parent) : back()}>
          <ChevronLeft className="size-4" />{t(page?.directory ? 'harness.parentFolder' : 'harness.chooseProject')}
        </Button>
        {page?.entries.map((item) => <Button key={item.path} type="button" variant="row" size="bare" className={row}
          disabled={busy} onClick={() => void load(item.path)}>
          <Folder className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 text-sm [overflow-wrap:anywhere]">
            {item.name}
            {!page.directory && item.path !== item.name && <span className="block text-xs text-muted-foreground">{item.path}</span>}
          </span><ChevronRight className="size-4 shrink-0" />
        </Button>)}
      </Surface>
      {busy ? <p role="status" className="px-2 py-3 text-sm text-muted-foreground">{t('harness.loading')}</p>
        : failure && !confirming ? <div className="space-y-2 py-2"><p role="alert" className="text-sm text-destructive">{failure}</p>
          <Button type="button" variant="outline" onClick={() => void load(lastPath.current)}>{t('settings:actions.retry')}</Button></div>
          : page && (!page.entries.length || page.truncated) && <p className="px-2 py-3 text-sm text-muted-foreground">{t(page.truncated ? 'harness.folderLimit' : page.directory ? 'harness.emptyFolder' : 'harness.noRoots')}</p>}
    </div>
    <Button type="button" className="min-h-11" disabled={busy || !!failure || !page?.directory || input !== page.directory.path} onClick={() => setConfirming(true)}>
      <Folders />{t('harness.useFolder')}
    </Button>
    {confirming && page?.directory && <ConfirmDialog title={t('harness.confirmProjectTitle')} itemName={page.directory.path}
      description={t('harness.confirmProjectHint', { computer: computer.name })} confirmLabel={t('harness.confirmProject')}
      tone="default" busy={busy} onCancel={() => { setConfirming(false); setFailure(''); }} onConfirm={() => void choose()}>
      {failure && <p role="alert" className="text-sm text-destructive">{failure}</p>}
    </ConfirmDialog>}
  </>;
}
