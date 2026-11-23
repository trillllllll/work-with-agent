import { useEffect, useState } from 'react';
import { Folder, FolderPlus } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog.js';
import { Surface } from '@/components/ui/surface.js';
import { editLocalSharedRoots } from '@/lib/desktop-node.js';

export function SharedDirectories({ nodeId, initialRoots }: { nodeId: string; initialRoots: string[] }) {
  const { t } = useTranslation('settings');
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [roots, setRoots] = useState(initialRoots);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setRoots(initialRoots); }, [initialRoots]);

  async function edit(change: Parameters<typeof editLocalSharedRoots>[1]) {
    setBusy(true);
    setError('');
    try {
      const result = await editLocalSharedRoots(nodeId, change);
      if (!result) setError(t('computers.directories.timeout'));
      else if (result.status === 'error') setError(result.message);
      else if (result.status === 'saved') {
        setRoots(result.roots);
        void client.invalidateQueries({ queryKey: ['nodes'] });
      }
    } catch {
      setError(t('computers.directories.timeout'));
    } finally {
      setBusy(false);
    }
  }

  return <Dialog open={open} onOpenChange={(next) => { if (!busy) { setOpen(next); setError(''); } }}>
    <DialogTrigger asChild>
      <Button type="button" size="sm" variant="outline">{t('computers.directories.manage')}</Button>
    </DialogTrigger>
    <DialogContent showCloseButton={!busy} className="flex max-h-[85dvh] flex-col overflow-hidden">
      <DialogHeader>
        <DialogTitle>{t('computers.directories.manage')}</DialogTitle>
        <DialogDescription>{t('computers.directories.hint')}</DialogDescription>
      </DialogHeader>
      <div className="glass-scrollbar min-h-0 overflow-y-auto">
        <Surface as="ul" tone="sheet" className="workspace-rows">
          {roots.map((path) => <li key={path} className="workspace-row flex min-h-11 items-center gap-2 px-2 py-1.5">
            <Folder className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 text-sm [overflow-wrap:anywhere]">{path}</span>
            <Button type="button" size="sm" variant="ghost" disabled={busy || roots.length === 1}
              aria-label={t('computers.directories.removePath', { path })}
              onClick={() => void edit({ action: 'remove', path })}>{t('computers.directories.remove')}</Button>
          </li>)}
        </Surface>
      </div>
      {roots.length === 1 && <p className="text-xs text-muted-foreground">{t('computers.directories.keepOne')}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter>
        {busy && <p role="status" className="self-center text-sm text-muted-foreground">{t('computers.directories.waiting')}</p>}
        <Button type="button" disabled={busy} onClick={() => void edit({ action: 'add' })}>
          <FolderPlus />{t('computers.directories.add')}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
