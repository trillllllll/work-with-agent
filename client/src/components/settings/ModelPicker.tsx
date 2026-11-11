import { Input } from '@/components/ui/input.js';
import { Button } from '@/components/ui/button.js';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.js';
import { api, type ModelCatalog, type ModelCatalogEntry } from '@/lib/api.js';
import { toast } from 'sonner';
import { useMutation } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Loader2 } from 'lucide-react';
import { cn } from 'cn';

/** 会话内的拉取缓存：卡片和编辑弹窗共用，同一段配置不重复打供应商接口。 */
const catalogCache = new Map<string, ModelCatalogEntry[]>();
const cacheKey = (scope: { baseUrl?: string; profileId?: string }) => (scope.profileId ? `id:${scope.profileId}` : `url:${scope.baseUrl ?? ''}`);
const fmtWindow = (value: number) => (value >= 1000 ? `${Math.round(value / 1000)}K` : String(value));
const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };

type ModelPickerProps = {
  /** 弹窗草稿场景给 baseUrl + apiKey（未保存也能拉）；已保存档案场景给 profileId，Key 留在服务端。 */
  baseUrl?: string;
  apiKey?: string;
  profileId?: string;
  value: string;
  /** 第二个参数是供应商在 /models 里声明的上下文上限，可能没有。 */
  onPick: (modelId: string, contextWindow?: number) => void;
  children: ReactElement;
};

/** 从接口的 /models 拉模型列表的浮层：可搜索、可手填兜底（读不到列表的中转也能用）。 */
export function ModelPicker({ baseUrl, apiKey, profileId, value, onPick, children }: ModelPickerProps) {
  const { t } = useTranslation('settings');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const key = cacheKey({ baseUrl, profileId });
  const [entries, setEntries] = useState<ModelCatalogEntry[] | null>(() => catalogCache.get(key) ?? null);
  const [failure, setFailure] = useState<{ reason: 'unreachable' | 'http_error'; status?: number } | null>(null);
  const fetchModels = useMutation({
    mutationFn: () => api<ModelCatalog>('/api/settings/models', { method: 'POST', body: JSON.stringify({ ...(baseUrl?.trim() ? { baseUrl: baseUrl.trim() } : {}), ...(apiKey?.trim() ? { apiKey: apiKey.trim() } : {}), ...(profileId ? { profileId } : {}) }) }),
    onSuccess: (data) => {
      if ('models' in data) {
        catalogCache.set(key, data.models);
        setEntries(data.models);
        setFailure(null);
        if (data.models.length) toast.success(t('modelSettings.modelFetched', { count: data.models.length }));
      } else {
        setEntries(null);
        setFailure(data);
        toast.error(data.reason === 'http_error' ? t('modelSettings.modelFetchFailed.http_error', { status: data.status ?? '' }) : t('modelSettings.modelFetchFailed.unreachable'));
      }
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const trimmed = query.trim();
  const lower = trimmed.toLowerCase();
  const exact = entries?.some((entry) => entry.id.toLowerCase() === lower);
  const filtered = entries && trimmed ? entries.filter((entry) => entry.id.toLowerCase().includes(lower)) : entries;
  const pick = (entry: ModelCatalogEntry) => { onPick(entry.id, entry.contextWindow); setOpen(false); setQuery(''); };
  const pickExactOrCustom = () => {
    const match = entries?.find((entry) => entry.id.toLowerCase() === lower);
    pick(match ?? { id: trimmed });
  };
  const rowClass = 'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs hover:bg-[var(--menu-highlight)]';

  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setQuery(''); }}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)] p-0">
        <div className="border-b border-[var(--glass-divider)] p-2">
          <Input
            variant="inline"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && trimmed) { event.preventDefault(); pickExactOrCustom(); } }}
            placeholder={t('modelSettings.modelSearchPlaceholder')}
            aria-label={t('modelSettings.modelSearchPlaceholder')}
            className="w-full rounded-lg border bg-transparent p-2 text-xs"
          />
        </div>
        <div className="max-h-64 overflow-y-auto p-1" role="listbox" aria-label={t('modelSettings.modelFetch')}>
          {failure && !entries && (
            <p className="p-3 text-center text-xs text-destructive">
              {failure.reason === 'http_error' ? t('modelSettings.modelFetchFailed.http_error', { status: failure.status ?? '' }) : t('modelSettings.modelFetchFailed.unreachable')}
              <br />
              <span className="text-muted-foreground">{t('modelSettings.modelManualHint')}</span>
            </p>
          )}
          {!entries && !failure && <p className="p-4 text-center text-xs text-muted-foreground">{t('modelSettings.modelEmpty')}</p>}
          {trimmed && !exact && (
            <Button type="button" variant="plain" size="bare" role="option" className={cn(rowClass, 'text-primary')} onClick={() => pick({ id: trimmed })}>
              <Check className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate font-mono">{t('modelSettings.customModel', { id: trimmed })}</span>
            </Button>
          )}
          {filtered?.map((entry) => (
            <Button type="button" variant="plain" size="bare" role="option" aria-selected={entry.id === value} key={entry.id} className={rowClass} onClick={() => pick(entry)}>
              <Check className={cn('size-3.5 shrink-0', entry.id === value ? 'text-primary' : 'invisible')} aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate font-mono">{entry.id}</span>
              {entry.contextWindow ? <span className="shrink-0 text-[11px] text-muted-foreground">{fmtWindow(entry.contextWindow)}</span> : null}
            </Button>
          ))}
          {entries && !filtered?.length && (exact || !trimmed) && <p className="p-3 text-center text-xs text-muted-foreground">{t('modelSettings.modelNoMatch', { query: trimmed })}</p>}
        </div>
        <div className="flex items-center gap-2 border-t border-[var(--glass-divider)] px-3 py-2 text-[11px] text-muted-foreground">
          <span className="min-w-0 truncate">{hostOf(baseUrl ?? '')}/models</span>
          <Button type="button" variant="outline" size="sm" className="ml-auto shrink-0" disabled={fetchModels.isPending} onClick={() => fetchModels.mutate()}>
            {fetchModels.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
            {entries ? t('modelSettings.modelRefetch') : t('modelSettings.modelFetch')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
