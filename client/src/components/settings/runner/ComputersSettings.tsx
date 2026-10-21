import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api, type View } from '@/lib/api.js';
import { isThisComputer, useLocalNode } from '@/lib/desktop-node.js';
import { Button } from '@/components/ui/button.js';
import { Skeleton } from '@/components/ui/skeleton.js';
import { AddComputerDialog } from './AddComputerDialog.js';
import { ComputerCard } from './ComputerCard.js';
import { ControllerCard } from './ControllerCard.js';
import { DisconnectDialog } from './DisconnectDialog.js';
import { RevokedComputers } from './RevokedComputers.js';
import type { Computer } from './types.js';

export function ComputersSettings({ onNavigate }: { onNavigate: (view: View) => void }) {
  const { t } = useTranslation('settings');
  const nodes = useQuery({ queryKey: ['nodes'], queryFn: () => api<Computer[]>('/api/nodes'), refetchInterval: 10_000 });
  const local = useLocalNode();
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const [adding, setAdding] = useState(false);
  const [disconnect, setDisconnect] = useState<Computer | null>(null);
  const active = (nodes.data ?? []).filter((computer) => computer.status === 'active');
  const revoked = (nodes.data ?? []).filter((computer) => computer.status !== 'active');
  return (
    <section aria-label={t('computers.aria')}>
      <p className="text-[13px] leading-relaxed text-muted-foreground">{t('computers.lead')}</p>
      <div className="mt-4"><ControllerCard origin={origin} /></div>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-lg font-semibold">{t('computers.list.title', { count: active.length })}</h3>
        <Button type="button" size="sm" onClick={() => setAdding(true)}>{t('computers.list.add')}</Button>
      </div>
      {nodes.isLoading ? <Skeleton className="mt-3 h-24 w-full" /> : nodes.isError ? (
        <p role="alert" className="mt-3 text-sm text-destructive">{nodes.error instanceof Error ? nodes.error.message : t('computers.loadFailed')}<Button type="button" size="sm" variant="ghost" onClick={() => void nodes.refetch()}>{t('actions.retry')}</Button></p>
      ) : active.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">{t('computers.list.empty')}</p>
      ) : (
        <div className="mt-3 space-y-3">
          {active.map((computer) => (
            <ComputerCard key={computer.id} computer={computer} thisComputer={isThisComputer(computer.id, local, origin)} onDisconnect={() => setDisconnect(computer)} />
          ))}
        </div>
      )}
      {nodes.data && <RevokedComputers computers={revoked} />}
      {adding && <AddComputerDialog onClose={() => setAdding(false)} />}
      {disconnect && (
        <DisconnectDialog
          computer={disconnect}
          local={isThisComputer(disconnect.id, local, origin)}
          onNavigate={onNavigate}
          onClose={() => setDisconnect(null)}
        />
      )}
    </section>
  );
}
