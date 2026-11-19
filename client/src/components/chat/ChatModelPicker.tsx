import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ModelPicker } from '@/components/settings/ModelPicker.js';
import { Button } from '@/components/ui/button.js';
import { api, type Settings } from '@/lib/api.js';

type ChatModelPickerProps = {
  settings?: Settings;
  disabled?: boolean;
};

export function ChatModelPicker({ settings, disabled }: ChatModelPickerProps) {
  const { t } = useTranslation('chat');
  const queryClient = useQueryClient();
  const profiles = settings?.profiles ?? [];
  const active = profiles.find((profile) => profile.id === settings?.activeProfileId) ?? profiles[0];
  const switchModel = useMutation({
    mutationFn: (model: string) => api<Settings>(`/api/settings/profiles/${active!.id}`, { method: 'PATCH', body: JSON.stringify({ model }) }),
    onSuccess: (data, model) => {
      queryClient.setQueryData(['settings'], data);
      toast.success(t('settings:modelSettings.modelSwitched', { model }));
    },
    onError: (error: Error) => toast.error(error.message),
  });
  if (!active) return <span className="truncate px-2">{settings?.model || t('status.noModel')}</span>;
  return <ModelPicker side="top" baseUrl={active.baseUrl} profileId={active.id} value={settings?.model ?? active.model} onPick={(model) => switchModel.mutate(model)}>
    <Button type="button" variant="plain" size="bare" className="assistant-context-trigger min-w-0 max-w-full" data-testid="assistant-model-trigger" disabled={disabled || switchModel.isPending} title={t('chatPanel.switchModel')} aria-label={t('chatPanel.switchModel')}>
      <span className="min-w-0 truncate">{settings?.model || active.model}</span>
      <ChevronDown className="size-3 shrink-0" />
    </Button>
  </ModelPicker>;
}
