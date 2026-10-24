import { Surface } from '@/components/ui/surface.js';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { intlLocale } from '@/i18n/index.js';
import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';
import { Input } from '@/components/ui/input.js';
import { Label } from '@/components/ui/label.js';
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog.js';
import { locationStatusLabels } from '@/components/orchestration/labels.js';
import { relativeTime } from '@/components/workspace/memory-view.js';
import { AddComputerDialog } from './AddComputerDialog.js';
import { copyText, engineLabel, formatBytes, LOW_DISK_BYTES } from './logic.js';
import type { Computer, IssuedNode, NodeCapabilities, ProviderCapability } from './types.js';

type CreatedNode = { node: { id: string; name: string }; token: string; serverUrl: string; command: string };

export function ComputerCard({ computer, thisComputer, onDisconnect }: { computer: Computer; thisComputer: boolean; onDisconnect: () => void }) {
  const { t } = useTranslation('settings');
  const capabilities = computer.capabilities ?? {};
  const snapshot = !computer.online && !!computer.lastSeenAt;
  const version = computer.version || capabilities.version || '';
  const platform = computer.platform || capabilities.platform || '';
  const [renameOpen, setRenameOpen] = useState(false);
  const [reissue, setReissue] = useState<'regenerate' | 'modify' | null>(null);
  const [issued, setIssued] = useState<IssuedNode | null>(null);
  const [autoStart, setAutoStart] = useState(false);
  const client = useQueryClient();
  const issue = useMutation({
    mutationFn: () => api<CreatedNode>(`/api/nodes/${encodeURIComponent(computer.id)}/token`, { method: 'POST', body: '{}' }),
    onSuccess: (data) => {
      setIssued({ nodeId: data.node.id, name: data.node.name || computer.name, command: data.command, token: data.token, serverUrl: data.serverUrl });
      setReissue(null);
      void client.invalidateQueries({ queryKey: ['nodes'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const presence = computer.online
    ? t('computers.card.online')
    : computer.lastSeenAt
      ? t('computers.card.offline', { time: relativeTime(computer.lastSeenAt) })
      : t('computers.card.never');
  return (
    <Surface as="article" tone="subtle" className="space-y-4 rounded-xl p-4">
      <header className="flex flex-wrap items-center gap-2">
        <h4 className="font-medium">{computer.name}</h4>
        {thisComputer && <Badge variant="secondary">{t('computers.card.thisComputer')}</Badge>}
        <span className={computer.online ? 'text-sm text-green-600' : 'text-sm text-muted-foreground'}>{presence}</span>
        <span className="text-xs text-muted-foreground">{platform || t('computers.card.unknown')}</span>
        <span className="text-xs text-muted-foreground">{version || t('computers.card.unknown')}</span>
        <span className="text-xs text-muted-foreground">{managedLabel(capabilities.managedBy, t)}</span>
        <span className="text-xs text-muted-foreground">{t('computers.card.jobs', { count: computer.activeJobs ?? 0 })}</span>
      </header>
      {snapshot && <p className="text-xs text-muted-foreground">{t('computers.card.snapshot')}</p>}
      {!version && computer.lastSeenAt && <p className="text-xs text-muted-foreground">{t('computers.card.oldVersion')}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Cell label={t('computers.card.providers')} mark={snapshot ? t('computers.card.snapshotMark') : undefined}>
          <ProviderLines capabilities={capabilities} reported={!!computer.lastSeenAt} />
        </Cell>
        <Cell label={t('computers.card.roots')} mark={snapshot ? t('computers.card.snapshotMark') : undefined}>
          {capabilities.allowedRoots?.length ? capabilities.allowedRoots.join(t('computers.card.rootSep')) : computer.lastSeenAt ? t('computers.card.noRoots') : t('computers.card.notReported')}
        </Cell>
        <Cell label={t('computers.card.concurrency')}>
          <p>{typeof capabilities.maxConcurrent === 'number' ? t('computers.card.concurrencyHint', { max: capabilities.maxConcurrent }) : t('computers.card.concurrencyUnknown')}</p>
        </Cell>
        <Cell label={t('computers.card.disk')} mark={snapshot ? t('computers.card.snapshotMark') : undefined}>
          <DiskAndGh capabilities={capabilities} reported={!!computer.lastSeenAt} />
        </Cell>
        <Cell label={t('computers.card.locations')}>
          {computer.locations.length === 0 ? t('computers.card.noLocations') : (
            <ul className="space-y-1">
              {computer.locations.map((location) => <li key={location.id}>{location.projectName} · {location.path} · {locationText(location.status, computer, t('computers.card.locationOffline'))}</li>)}
            </ul>
          )}
        </Cell>
        <Cell label={t('computers.card.log')}>
          {capabilities.logPath ? (
            <span className="inline-flex flex-wrap items-center gap-2">
              <code className="break-all">{capabilities.logPath}</code>
              <Button type="button" size="sm" variant="ghost" onClick={() => { void copyText(capabilities.logPath || '').then((ok) => { if (ok) toast.success(t('computers.card.copied')); else toast.error(t('computers.card.copyFailed')); }); }}>{t('computers.card.copy')}</Button>
            </span>
          ) : computer.lastSeenAt ? t('computers.card.noLog') : t('computers.card.notReported')}
        </Cell>
        <Cell label={t('computers.card.lastError')}>
          {capabilities.lastError || (computer.lastSeenAt ? t('computers.card.noError') : t('computers.card.notReported'))}
        </Cell>
        <Cell label={t('computers.card.token')}>
          {t('computers.card.tokenCreated', { time: new Date(computer.createdAt).toLocaleString(intlLocale()) })}
        </Cell>
      </div>
      {!thisComputer && <p className="text-[13px] leading-relaxed text-muted-foreground">{t('computers.card.remoteNote')}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => setRenameOpen(true)}>{t('computers.card.rename')}</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => { setAutoStart(false); setReissue('regenerate'); }}>{t('computers.card.regenerate')}</Button>
        {thisComputer ? (
          <>
            <Button type="button" size="sm" variant="outline" onClick={() => { setAutoStart(true); setReissue('modify'); }}>{t('computers.card.modify')}</Button>
            <Button type="button" size="sm" variant="ghost" className="text-destructive" onClick={onDisconnect}>{t('computers.card.disconnect')}</Button>
          </>
        ) : (
          <Button type="button" size="sm" variant="ghost" className="text-destructive" onClick={onDisconnect}>{t('computers.card.revoke')}</Button>
        )}
      </div>
      {renameOpen && <RenameDialog computer={computer} onClose={() => setRenameOpen(false)} />}
      {reissue && (
        <ConfirmDialog
          title={t('computers.reissue.title')}
          itemName={computer.name}
          description={reissue === 'modify' ? t('computers.reissue.modify') : t('computers.reissue.regenerate')}
          confirmLabel={t('computers.reissue.confirm')}
          busy={issue.isPending}
          onCancel={() => setReissue(null)}
          onConfirm={() => issue.mutate()}
        />
      )}
      {issued && <AddComputerDialog initial={issued} autoStart={autoStart} onClose={() => setIssued(null)} />}
    </Surface>
  );
}

function managedLabel(managedBy: string | undefined, t: (key: string) => string) {
  if (managedBy === 'desktop') return t('computers.card.managedDesktop');
  if (managedBy === 'cli') return t('computers.card.managedCli');
  return t('computers.card.managedUnknown');
}

function locationText(status: string, computer: Computer, offline: string) {
  if (status === 'pending' && !computer.online && computer.lastSeenAt) return offline;
  return locationStatusLabels[status] ?? status;
}

function Cell({ label, mark, children }: { label: string; mark?: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}{mark ? ` · ${mark}` : ''}</div>
      <div className="break-all text-sm">{children}</div>
    </div>
  );
}

function ProviderLines({ capabilities, reported }: { capabilities: NodeCapabilities; reported: boolean }) {
  const { t } = useTranslation('settings');
  if (!reported) return t('computers.card.notReported');
  const providers = (capabilities.providers ?? []).filter((item) => item.available);
  if (!providers.length) return t('computers.card.noProvider');
  return (
    <ul className="space-y-1">
      <li className="text-xs text-muted-foreground">{t('computers.card.reported')}</li>
      {providers.map((item) => <li key={item.provider}>{providerLine(item)}</li>)}
    </ul>
  );
}

function providerLine(item: ProviderCapability) {
  const bits = [engineLabel(item.provider), item.version, item.path].filter(Boolean);
  return bits.join(' · ');
}

function DiskAndGh({ capabilities, reported }: { capabilities: NodeCapabilities; reported: boolean }) {
  const { t } = useTranslation('settings');
  if (!reported) return t('computers.card.notReported');
  const free = capabilities.freeBytes;
  const disk = typeof free === 'number' ? formatBytes(free) : t('computers.card.diskUnknown');
  const low = typeof free === 'number' && free < LOW_DISK_BYTES;
  const gh = capabilities.gh === true ? t('computers.card.ghYes') : capabilities.gh === false ? t('computers.card.ghNo') : t('computers.card.diskUnknown');
  return (
    <div className="space-y-1">
      <p>{disk} · {t('computers.card.gh')} {gh}</p>
      <p className={low ? 'text-destructive' : 'text-muted-foreground'}>{t('computers.card.diskLow')}</p>
    </div>
  );
}

function RenameDialog({ computer, onClose }: { computer: Computer; onClose: () => void }) {
  const { t } = useTranslation('settings');
  const client = useQueryClient();
  const [name, setName] = useState(computer.name);
  const save = useMutation({
    mutationFn: () => api(`/api/nodes/${encodeURIComponent(computer.id)}`, { method: 'PATCH', body: JSON.stringify({ name: name.trim() }) }),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ['nodes'] }); toast.success(t('computers.rename.saved')); onClose(); },
    onError: (error: Error) => toast.error(error.message),
  });
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !save.isPending) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('computers.rename.title')}</DialogTitle>
          <DialogDescription>{computer.name}</DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); if (name.trim()) save.mutate(); }}>
          <Label htmlFor={`rename-${computer.id}`}>{t('computers.rename.name')}</Label>
          <Input id={`rename-${computer.id}`} value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={save.isPending} onClick={onClose}>{t('actions.cancel')}</Button>
            <Button type="submit" disabled={!name.trim() || save.isPending}>{t('computers.rename.save')}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
