import { useEffect, useRef, useState } from 'react';
import { useQueryClient, useQuery, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, Download, RotateCcw } from 'lucide-react';
import { api, authHeaders, type CliCommandSetting, type Settings } from '@/lib/api.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Label } from '@/components/ui/label.js';
import { Skeleton } from '@/components/ui/skeleton.js';
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog.js';
import { MobileNavigationSettings } from '@/components/settings/MobileNavigationSettings.js';

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
        <header className="border-b glass-divider pb-5">
          <span className="text-[11px] font-bold tracking-[0.13em] text-muted-foreground uppercase">系统配置</span>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">模型设置</h1>
        </header>
        <MobileNavigationSettings />
        <div className="mt-8 border-t glass-divider pt-8" aria-busy="true">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="mt-4 h-10 w-full" />
          <Skeleton className="mt-4 h-10 w-full" />
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

      <MobileNavigationSettings />

      {settingsQuery.isError ? (
        <div className="mt-8 flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <span>{settingsQuery.error instanceof Error ? settingsQuery.error.message : '设置加载失败'}</span>
          <Button size="sm" variant="outline" onClick={() => settingsQuery.refetch()}>重试</Button>
        </div>
      ) : (
        <div className="mt-8 border-t glass-divider pt-8">
          <form
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
        </div>
      )}

      {!settingsQuery.isError && (
        <>
          <CliCommands settings={settingsQuery.data} />

          <BackupSection />

          <ServerInfo />
        </>
      )}

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

const cliNames = { codex: 'Codex', claude: 'Claude Code' } as const;

export type ServerInfo = { mode: 'local' | 'server'; version: string };
type SnapshotEntry = { name: string; size: number; createdAt: string };

function formatBytes(size: number) {
  if (size >= 1_048_576) return `${(size / 1_048_576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(size / 1_024))} KB`;
}

function BackupSection() {
  const queryClient = useQueryClient();
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoreMode, setRestoreMode] = useState<'merge' | 'replace' | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const snapshotsQuery = useQuery<SnapshotEntry[]>({ queryKey: ['server-snapshots'], queryFn: () => api('/api/v1/server/snapshots') });

  async function download() {
    const response = await fetch('/api/v1/server/snapshot', { credentials: 'include', headers: authHeaders() });
    if (!response.ok) throw new Error(`下载失败（${response.status}）`);
    const disposition = response.headers.get('Content-Disposition') ?? '';
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `wwa-snapshot-${Date.now()}.zip`;
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
    toast.success('快照已开始下载。');
  }

  const restore = useMutation<void, Error, 'merge' | 'replace'>({
    mutationFn: async (mode) => {
      if (!restoreFile) throw new Error('请先选择快照文件');
      const response = await fetch(`/api/v1/server/snapshot/import?mode=${mode}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/zip', ...authHeaders() },
        body: restoreFile,
      });
      const body = await response.json().catch(() => ({ error: '响应格式错误' }));
      if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : '恢复失败');
      if (mode === 'merge') {
        const inserted = body.data?.inserted ?? 0;
        const skipped = body.data?.skipped ?? 0;
        toast.success(`已并入 ${inserted} 条，跳过 ${skipped} 条已有记录。`);
        await queryClient.invalidateQueries();
        return;
      }
      // The service exits to apply the restored database; wait for it to come back.
      for (let attempt = 0; attempt < 120; attempt += 1) {
        await new Promise((done) => setTimeout(done, 1_000));
        const probe = await fetch('/api/v1/server/info').catch(() => null);
        if (probe?.ok) {
          window.location.reload();
          return;
        }
      }
      window.location.reload();
    },
    onSuccess: () => { setRestoreFile(null); setRestoreMode(null); if (fileInput.current) fileInput.current.value = ''; void queryClient.invalidateQueries({ queryKey: ['server-snapshots'] }); },
    onError: (error) => { setRestoreMode(null); toast.error(error.message); },
  });

  return (
    <section className="mt-10 border-t glass-divider pt-6">
      <h2 className="text-lg font-semibold">备份与恢复</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">快照包含全部工作数据（任务、材料、对话、记忆）。并入会补上没有的记录并保留这边已有的 id。覆盖会用快照换掉当前库。</p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" onClick={() => { void download().catch((error) => toast.error(error.message)); }}><Download className="size-4" />下载快照</Button>
        <input ref={fileInput} id="restore-file" type="file" accept=".zip" className="hidden" onChange={(event) => setRestoreFile(event.target.files?.[0] ?? null)} />
        <Button type="button" variant="outline" disabled={!restoreFile || restore.isPending} onClick={() => setRestoreMode('merge')}>{restore.isPending && restoreMode === 'merge' ? '正在并入…' : '并入此快照'}</Button>
        <Button type="button" variant="outline" disabled={!restoreFile || restore.isPending} onClick={() => setRestoreMode('replace')}><RotateCcw className="size-4" />{restore.isPending && restoreMode === 'replace' ? '正在恢复…' : '恢复此快照'}</Button>
        <Button type="button" variant="ghost" onClick={() => fileInput.current?.click()}>{restoreFile ? `已选择：${restoreFile.name}` : '选择快照文件…'}</Button>
      </div>
      {!!snapshotsQuery.data?.length && (
        <ul className="glass-subtle mt-4 space-y-1.5 rounded-xl p-4 text-xs text-muted-foreground">
          {snapshotsQuery.data.slice(0, 5).map((snapshot) => (
            <li key={snapshot.name} className="flex items-baseline justify-between gap-3">
              <span className="truncate font-mono">{snapshot.name}</span>
              <span className="shrink-0">{formatBytes(snapshot.size)}</span>
            </li>
          ))}
        </ul>
      )}
      {restoreMode && (
        <ConfirmDialog
          title={restoreMode === 'merge' ? '并入快照' : '恢复快照'}
          itemName={restoreFile?.name ?? '选中的快照'}
          description={restoreMode === 'merge'
            ? '已有 id 保持原样，快照里缺的记录会补上，这边多出来的记录保留。设置和登录会话不动，服务不用重启。开始前会先自动备份一份。'
            : '当前数据会先自动备份一份，然后用快照内容替换。恢复期间服务会短暂重启。'}
          busy={restore.isPending}
          onCancel={() => { if (!restore.isPending) setRestoreMode(null); }}
          onConfirm={() => restore.mutate(restoreMode)}
        />
      )}
    </section>
  );
}

function ServerInfo() {
  const infoQuery = useQuery<ServerInfo>({ queryKey: ['server-info'], queryFn: () => api('/api/v1/server/info') });
  const inDesktopShell = typeof window !== 'undefined' && '__TAURI__' in window;
  if (infoQuery.isError) return null;
  const info = infoQuery.data;
  return (
    <section className="mt-10 border-t glass-divider pt-6">
      <h2 className="text-lg font-semibold">服务器</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
        {info?.mode === 'server' ? '当前连接的是自托管服务器，所有设备共用这一份数据。' : '当前使用本机数据。切换到自托管服务器可实现多设备同步（见部署文档）。'}
      </p>
      <dl className="glass-subtle mt-4 grid gap-3 rounded-xl p-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted-foreground">模式</dt>
          <dd className="mt-0.5">{info ? (info.mode === 'server' ? '服务器（多端同步）' : '本机') : '…'}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">服务版本</dt>
          <dd className="mt-0.5 font-mono">{info?.version ?? '…'}</dd>
        </div>
      </dl>
      {inDesktopShell && (
        <Button type="button" variant="outline" className="mt-4" onClick={() => { window.location.assign('/wwa-launcher'); }}>切换工作区模式</Button>
      )}
    </section>
  );
}

function CliCommands({ settings }: { settings?: Settings }) {
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState({ codex: '', claude: '' });
  const [notice, setNotice] = useState('');
  const discover = useMutation({
    mutationFn: () => api<Settings>('/api/settings/cli/discover', { method: 'POST', body: '{}' }),
    onSuccess: (data) => {
      queryClient.setQueryData(['settings'], data);
      const pending = (['codex', 'claude'] as const).filter((provider) => data.discovered?.[provider] && data.cli?.[provider]?.source === 'manual' && data.discovered[provider].command && data.discovered[provider].command !== data.cli?.[provider]?.manualCommand);
      const missing = (['codex', 'claude'] as const).filter((provider) => data.discovered?.[provider]?.message);
      setNotice([pending.length ? `已保留手动配置。自动检查另发现：${pending.map((provider) => `${cliNames[provider]} ${data.discovered?.[provider]?.command}`).join('、')}` : '自动检查已更新。', missing.map((provider) => data.discovered?.[provider]?.message).filter(Boolean).join('；')].filter(Boolean).join(' '));
    },
    onError: (error: Error) => setNotice(error.message),
  });
  const saveManual = useMutation({
    mutationFn: (input: { provider: 'codex' | 'claude'; command: string }) => api<CliCommandSetting>('/api/settings/cli', { method: 'PUT', body: JSON.stringify(input) }),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['settings'] }); setNotice('手动命令已保存。'); },
    onError: (error: Error) => setNotice(error.message),
  });
  const restore = useMutation({
    mutationFn: (provider: 'codex' | 'claude') => api<CliCommandSetting>(`/api/settings/cli/${provider}`, { method: 'DELETE' }),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['settings'] }); setNotice('已改回自动发现的命令。'); },
    onError: (error: Error) => setNotice(error.message),
  });
  return (
    <section className="mt-10 border-t glass-divider pt-6">
      <h2 className="text-lg font-semibold">本机 AI 命令</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">从登录 shell 查找 Codex 和 Claude Code 的启动命令。手动填写的绝对路径优先，自动检查不会覆盖它。</p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" disabled={discover.isPending} onClick={() => discover.mutate()}>{discover.isPending ? '正在检查…' : '自动检查'}</Button>
        {notice && <p className="text-xs text-muted-foreground">{notice}</p>}
      </div>
      {(['codex', 'claude'] as const).map((provider) => {
        const item = settings?.cli?.[provider];
        const source = item?.source === 'manual' ? '手动配置' : item?.source === 'auto' ? '自动发现' : '尚未找到';
        return (
          <form key={provider} className="glass-subtle mt-4 space-y-3 rounded-xl p-4" onSubmit={(event) => { event.preventDefault(); saveManual.mutate({ provider, command: drafts[provider] || item?.command || '' }); }}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-medium">{cliNames[provider]}</h3>
              <span className="text-xs text-muted-foreground">{source}{item?.version ? ` · ${item.version}` : ''}</span>
            </div>
            <p className="break-all text-xs text-muted-foreground">{item?.command || '还没有可用命令'}</p>
            <Label htmlFor={`cli-${provider}`}>命令路径</Label>
            <Input id={`cli-${provider}`} value={drafts[provider]} onChange={(event) => setDrafts((current) => ({ ...current, [provider]: event.target.value }))} placeholder={item?.command || (provider === 'codex' ? '/绝对路径/codex' : '/绝对路径/claude')} />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" disabled={saveManual.isPending}>保存手动配置</Button>
              {item?.source === 'manual' && <Button type="button" size="sm" variant="outline" disabled={restore.isPending} onClick={() => restore.mutate(provider)}>恢复自动</Button>}
            </div>
          </form>
        );
      })}
    </section>
  );
}
