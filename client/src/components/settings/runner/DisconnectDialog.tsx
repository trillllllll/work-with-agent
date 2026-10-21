import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { disconnectThisComputer, requestLocalUnpair, type DisconnectResult } from '@/lib/desktop-node.js';
import { Button } from '@/components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog.js';
import type { View } from '@/lib/api.js';
import type { Computer } from './types.js';

export function DisconnectDialog({ computer, local, onNavigate, onClose }: { computer: Computer; local: boolean; onNavigate: (view: View) => void; onClose: () => void }) {
  const { t } = useTranslation('settings');
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DisconnectResult | null>(null);
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['nodes'] });
    void client.invalidateQueries({ queryKey: ['projects'] });
    void client.invalidateQueries({ queryKey: ['orchestrations'] });
  };
  const runLocal = async () => {
    setBusy(true);
    try {
      const next = await disconnectThisComputer(computer.id);
      setResult(next);
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('computers.loadFailed'));
    } finally {
      setBusy(false);
    }
  };
  const retry = async () => {
    setBusy(true);
    try {
      const unpair = await requestLocalUnpair(computer.id);
      setResult((current) => ({ cancelledJobIds: current?.cancelledJobIds ?? [], pausedOrchestrationIds: current?.pausedOrchestrationIds ?? [], local: unpair }));
    } finally {
      setBusy(false);
    }
  };
  const runRemote = async () => {
    setBusy(true);
    try {
      await api(`/api/nodes/${encodeURIComponent(computer.id)}/revoke`, { method: 'POST', body: '{}' });
      toast.success(t('computers.disconnect.remoteDone'));
      refresh();
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('computers.loadFailed'));
      setBusy(false);
    }
  };
  if (result) {
    const stopped = result.local?.ok === true && result.local.stopped === true;
    return (
      <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('computers.disconnect.resultTitle')}</DialogTitle>
            <DialogDescription>{stopped ? t('computers.disconnect.stopped') : t('computers.disconnect.notStopped')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1 text-sm">
            {stopped && result.local?.configRemoved && <p>{t('computers.disconnect.configRemoved')}</p>}
            <p>{t('computers.disconnect.cancelled', { count: result.cancelledJobIds.length })}</p>
            <p>{t('computers.disconnect.paused', { count: result.pausedOrchestrationIds.length })}</p>
            {result.local && result.local.cancelled > 0 && <p>{t('computers.disconnect.shellCancelled', { count: result.local.cancelled })}</p>}
            {result.local?.message && <p className="text-muted-foreground">{t('computers.disconnect.shellMessage', { message: result.local.message })}</p>}
          </div>
          <DialogFooter>
            {!stopped && <Button type="button" disabled={busy} onClick={() => void retry()}>{t('computers.disconnect.retry')}</Button>}
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>{t('computers.disconnect.close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <ConfirmDialog
      title={local ? t('computers.disconnect.titleLocal') : t('computers.disconnect.titleRemote')}
      itemName={computer.name}
      description={local ? t('computers.disconnect.localIntro') : t('computers.disconnect.remoteIntro')}
      confirmLabel={local ? t('computers.disconnect.confirmLocal') : t('computers.disconnect.confirmRemote')}
      busy={busy}
      onCancel={onClose}
      onConfirm={() => { if (local) void runLocal(); else void runRemote(); }}
    >
      <div className="space-y-2 text-sm">
        <p>{t('computers.disconnect.jobs', { count: computer.activeJobs ?? 0 })}</p>
        <p>{t('computers.disconnect.locations', { count: computer.locations.length })}</p>
        {computer.locations.length > 0 && (
          <ul className="max-h-32 space-y-1 overflow-auto text-xs text-muted-foreground">
            {computer.locations.map((location) => <li key={location.id} className="break-all">{location.projectName} · {location.path}</li>)}
          </ul>
        )}
        <p className="text-[13px] leading-relaxed text-muted-foreground">{t('computers.disconnect.pauseNote')}</p>
        <div>
          <p>{t('computers.disconnect.worktrees')}</p>
          <Button type="button" variant="link" className="h-auto px-0" onClick={() => { onClose(); onNavigate('worktrees'); }}>{t('computers.disconnect.worktreesLink')}</Button>
        </div>
      </div>
    </ConfirmDialog>
  );
}
