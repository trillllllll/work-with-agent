import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { Button } from '@/components/ui/button.js';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible.js';
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog.js';
import { relativeTime } from '@/components/workspace/memory-view.js';
import { errorCode } from './errors.js';
import type { Computer } from './types.js';

export function RevokedComputers({ computers }: { computers: Computer[] }) {
  const { t } = useTranslation('settings');
  const [pending, setPending] = useState<Computer | null>(null);
  if (computers.length === 0) return null;
  return (
    <Collapsible className="mt-4">
      <CollapsibleTrigger type="button" className="group flex w-full items-center gap-2 rounded-lg px-1 py-2 text-left text-sm text-muted-foreground hover:text-foreground">
        <ChevronDown aria-hidden="true" className="size-4 transition-transform group-data-[state=open]:rotate-180" />
        <span>{t('computers.revoked.title', { count: computers.length })}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 pt-2">
        {computers.map((computer) => (
          <div key={computer.id} className="glass-subtle flex flex-wrap items-center gap-2 rounded-xl px-3 py-2 text-sm">
            <span className="font-medium">{computer.name}</span>
            <span className="text-xs text-muted-foreground">{t('computers.revoked.when', { time: relativeTime(computer.updatedAt) })}</span>
            <Button type="button" size="sm" variant="ghost" className="ml-auto text-destructive" onClick={() => setPending(computer)}>{t('computers.revoked.delete')}</Button>
          </div>
        ))}
      </CollapsibleContent>
      {pending && <DeleteRevoked computer={pending} onClose={() => setPending(null)} />}
    </Collapsible>
  );
}

function DeleteRevoked({ computer, onClose }: { computer: Computer; onClose: () => void }) {
  const { t } = useTranslation('settings');
  const client = useQueryClient();
  const hasLocations = computer.locations.length > 0;
  const remove = useMutation({
    mutationFn: (removeLocations: boolean) => api(`/api/nodes/${encodeURIComponent(computer.id)}${removeLocations ? '?removeLocations=1' : ''}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['nodes'] });
      await client.invalidateQueries({ queryKey: ['projects'] });
      toast.success(t('computers.revoked.deleted'));
      onClose();
    },
    onError: (error: Error, removeLocations: boolean) => {
      if (!removeLocations && errorCode(error) === 'NODE_HAS_LOCATIONS') {
        remove.mutate(true);
        return;
      }
      toast.error(error.message);
    },
  });
  return (
    <ConfirmDialog
      title={t('computers.revoked.deleteTitle')}
      itemName={computer.name}
      description={hasLocations ? t('computers.revoked.deleteLocations') : t('computers.revoked.deleteDescription')}
      confirmLabel={t('computers.revoked.confirm')}
      busy={remove.isPending}
      onCancel={onClose}
      onConfirm={() => remove.mutate(hasLocations)}
    />
  );
}
