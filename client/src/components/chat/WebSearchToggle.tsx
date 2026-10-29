import { Button } from '@/components/ui/button.js';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api.js';
import { Globe } from 'lucide-react';
import { cn } from '@/lib/utils.js';

type WebSearchToggleProps = {
  enabled: boolean;
  busy?: boolean;
  onToggle: (enabled: boolean) => void;
};

/** 会话级联网搜索开关。未配置 DeepSeek 联网搜索服务时禁用。 */
export function WebSearchToggle({ enabled, busy, onToggle }: WebSearchToggleProps) {
  const { t } = useTranslation('chat');
  const settings = useQuery({ queryKey: ['web-search-settings'], queryFn: () => api<{ configured: boolean }>('/api/settings/web-search') });
  const available = settings.isLoading || Boolean(settings.data?.configured);
  const title = !available ? t('chatPanel.webSearchUnavailable') : enabled ? t('chatPanel.webSearchOn') : t('chatPanel.webSearchOff');
  return (
    <Button
      type="button"
      variant="ghost"
      size="bare"
      aria-pressed={enabled}
      disabled={busy || !available}
      data-testid="web-search-toggle"
      className={cn('flex h-7 shrink-0 items-center gap-1 rounded-full border px-2 text-[11px] transition-colors', enabled ? 'border-primary/40 bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground')}
      title={title}
      aria-label={title}
      onClick={() => onToggle(!enabled)}
    >
      <Globe className="size-3" />
      <span>{t('chatPanel.webSearch')}</span>
    </Button>
  );
}
