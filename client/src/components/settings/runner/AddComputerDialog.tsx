import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { inDesktopShell } from '@/lib/desktop-shell.js';
import { requestLocalPair } from '@/lib/desktop-node.js';
import { Button } from '@/components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';
import { Input } from '@/components/ui/input.js';
import { Label } from '@/components/ui/label.js';
import { copyText } from './logic.js';
import type { IssuedNode } from './types.js';

type CreatedNode = { node: { id: string; name: string }; token: string; serverUrl: string; command: string };

export function AddComputerDialog({ initial = null, autoStart = false, onClose }: { initial?: IssuedNode | null; autoStart?: boolean; onClose: () => void }) {
  const { t } = useTranslation('settings');
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [created, setCreated] = useState<IssuedNode | null>(null);
  const [pairNonce, setPairNonce] = useState(0);
  const [pairNote, setPairNote] = useState('');
  const armed = useRef(false);
  const issued = initial ?? created;
  const desktop = inDesktopShell();
  const create = useMutation({
    mutationFn: () => api<CreatedNode>('/api/nodes', { method: 'POST', body: JSON.stringify({ name: name.trim() }) }),
    onSuccess: (data) => {
      setCreated({ nodeId: data.node.id, name: data.node.name, command: data.command, token: data.token, serverUrl: data.serverUrl });
      void client.invalidateQueries({ queryKey: ['nodes'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  useEffect(() => {
    if (!autoStart || !issued || armed.current) return;
    armed.current = true;
    setPairNonce(1);
  }, [autoStart, issued]);
  useEffect(() => {
    if (!issued || pairNonce === 0) return;
    const waiter = requestLocalPair(issued.serverUrl, issued.token, issued.nodeId);
    let live = true;
    setPairNote('');
    void waiter.promise.then((result) => {
      if (!live) return;
      if (!result) setPairNote(t('computers.add.pairTimeout'));
      else if (result.ok) { setPairNote(t('computers.add.pairOk')); toast.success(t('computers.add.pairOk')); }
      else { const message = t('computers.add.pairFailed', { message: result.message }); setPairNote(message); toast.error(message); }
    });
    return () => { live = false; waiter.cancel(); };
  }, [pairNonce, issued]);
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !create.isPending) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{issued && initial ? t('computers.add.regenerateTitle') : t('computers.add.title')}</DialogTitle>
          <DialogDescription>{issued ? t('computers.add.once') : t('computers.add.commandHint')}</DialogDescription>
        </DialogHeader>
        {!issued ? (
          <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); if (name.trim()) create.mutate(); }}>
            <Label htmlFor="add-computer-name">{t('computers.add.name')}</Label>
            <Input id="add-computer-name" value={name} maxLength={100} placeholder={t('computers.add.namePlaceholder')} onChange={(event) => setName(event.target.value)} />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" disabled={create.isPending} onClick={onClose}>{t('actions.cancel')}</Button>
              <Button type="submit" disabled={!name.trim() || create.isPending}>{t('computers.add.create')}</Button>
            </div>
          </form>
        ) : (
          <div className="space-y-3 text-sm">
            <p className="text-[13px] leading-relaxed text-muted-foreground">{t('computers.add.commandHint')}</p>
            <code className="block break-all rounded-lg bg-muted px-3 py-2 text-xs">{issued.command}</code>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => { void copyText(issued.command).then((ok) => { if (ok) toast.success(t('computers.add.copied')); else toast.error(t('computers.card.copyFailed')); }); }}>{t('computers.add.copy')}</Button>
              {desktop && <Button type="button" size="sm" onClick={() => setPairNonce((value) => value + 1)}>{t('computers.add.start')}</Button>}
            </div>
            {pairNote && <p role="status" className="text-xs text-muted-foreground">{pairNote}</p>}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
