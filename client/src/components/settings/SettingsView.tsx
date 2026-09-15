import { useEffect, useState } from 'react';
import { useQueryClient, useQuery, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft } from 'lucide-react';
import { api, type Settings } from '@/lib/api.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Label } from '@/components/ui/label.js';
import { Skeleton } from '@/components/ui/skeleton.js';
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog.js';

export function SettingsView({ onBack }: { onBack?: () => void }) {
  const queryClient = useQueryClient();
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [clearKeyConfirmation, setClearKeyConfirmation] = useState(false);
  const settingsQuery = useQuery<Settings>({ queryKey: ['settings'], queryFn: () => api('/api/settings') });
  useEffect(() => {
    if (!settingsQuery.data) return;
    setBaseUrl(settingsQuery.data.baseUrl);
    setModel(settingsQuery.data.model);
  }, [settingsQuery.data]);
  const save = useMutation<Settings, Error, void>({
    mutationFn: () => api('/api/settings', { method: 'PATCH', body: JSON.stringify({ baseUrl, model, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }) }),
    onSuccess: (data) => { queryClient.setQueryData(['settings'], data); setApiKey(''); toast.success('设置已保存，连接测试通过。'); },
    onError: (error) => { toast.error(error.message); },
  });
  const clearKey = useMutation<Settings, Error, void>({
    mutationFn: () => api('/api/settings/api-key', { method: 'DELETE' }),
    onSuccess: (data) => { queryClient.setQueryData(['settings'], data); setClearKeyConfirmation(false); setApiKey(''); toast.success('API Key 已清除。'); },
    onError: (error) => { setClearKeyConfirmation(false); toast.error(error.message); },
  });

  if (settingsQuery.isLoading) {
    return (
      <div className="min-h-full max-w-2xl p-6 sm:p-8">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="mt-6 h-10 w-full" />
        <Skeleton className="mt-4 h-10 w-full" />
        <Skeleton className="mt-4 h-10 w-full" />
      </div>
    );
  }
  if (settingsQuery.isError) {
    return (
      <div className="min-h-full p-6 sm:p-8">
        <div className="flex max-w-xl items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <span>{settingsQuery.error instanceof Error ? settingsQuery.error.message : '设置加载失败'}</span>
          <Button size="sm" variant="outline" onClick={() => settingsQuery.refetch()}>重试</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full max-w-2xl p-5 pb-10 sm:p-8">
      <header className="flex items-start justify-between gap-3 border-b glass-divider pb-5">
        <div className="flex items-start gap-2">
          {onBack && (
            <Button variant="ghost" size="icon-sm" aria-label="返回" onClick={onBack}><ArrowLeft /></Button>
          )}
          <div>
            <span className="text-[11px] font-bold tracking-[0.13em] text-muted-foreground uppercase">系统配置</span>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">模型设置</h1>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">配置 OpenAI Chat Completions 兼容服务，保存前会测试连接。</p>
          </div>
        </div>
      </header>

      <form
        className="mt-6"
        onSubmit={(event) => { event.preventDefault(); save.mutate(); }}
      >
        <div className="mb-4">
          <Label htmlFor="settings-base-url">接口地址</Label>
          <Input id="settings-base-url" required value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.openai.com/v1" />
        </div>
        <div className="mb-4">
          <Label htmlFor="settings-model">模型名称</Label>
          <Input id="settings-model" required value={model} onChange={(event) => setModel(event.target.value)} placeholder="gpt-4o-mini" />
        </div>
        <div className="mb-4">
          <Label htmlFor="settings-api-key">API Key</Label>
          <Input id="settings-api-key" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={settingsQuery.data?.apiKeyConfigured ? `已配置：${settingsQuery.data.apiKeyMasked}` : '请输入 API Key'} autoComplete="new-password" />
        </div>
        <div className="glass-subtle mb-6 rounded-xl px-3.5 py-2.5 text-xs text-muted-foreground">
          {settingsQuery.data?.apiKeyConfigured ? <>当前 Key：<code className="font-mono text-foreground">{settingsQuery.data.apiKeyMasked}</code></> : '当前尚未配置 API Key'}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={save.isPending || clearKey.isPending}>{save.isPending ? '正在测试连接…' : '测试连接并保存'}</Button>
          {settingsQuery.data?.apiKeyConfigured && (
            <Button type="button" variant="outline" className="text-destructive hover:bg-destructive/10 hover:text-destructive" disabled={save.isPending || clearKey.isPending} onClick={() => setClearKeyConfirmation(true)}>
              {clearKey.isPending ? '正在清除…' : '清除 API Key'}
            </Button>
          )}
        </div>
      </form>

      {clearKeyConfirmation && (
        <ConfirmDialog
          title="清除 API Key"
          itemName="当前已保存的 API Key"
          description="清除后将无法继续使用当前模型配置，聊天需要重新配置 API Key。"
          busy={clearKey.isPending}
          onCancel={() => setClearKeyConfirmation(false)}
          onConfirm={() => clearKey.mutate()}
        />
      )}
    </div>
  );
}
