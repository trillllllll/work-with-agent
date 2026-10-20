import { ImageSearchSettings } from './ImageSearchSettings.js';
import { HtmlBlockSettings } from './HtmlBlockSettings.js';
import { useEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { LanguageSettings } from './LanguageSettings.js';
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
  const { t } = useTranslation('settings');
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
    onSuccess: (data) => { queryClient.setQueryData(['settings'], data); setApiKey(''); toast.success(t('modelSettings.saved')); },
    onError: (error) => { toast.error(error.message); },
  });
  const clearKey = useMutation<Settings, Error, void>({
    mutationFn: () => api('/api/settings/api-key', { method: 'DELETE' }),
    onSuccess: (data) => { queryClient.setQueryData(['settings'], data); setClearKeyConfirmation(false); setApiKey(''); toast.success(t('modelSettings.cleared')); },
    onError: (error) => { setClearKeyConfirmation(false); toast.error(error.message); },
  });

  if (settingsQuery.isLoading) {
    return (
      <div className="min-h-full max-w-2xl p-6 sm:p-8">
        <header className="border-b glass-divider pb-5">
          <span className="text-[11px] font-bold tracking-[0.13em] text-muted-foreground uppercase">{t('modelSettings.eyebrow')}</span>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">{t('modelSettings.title')}</h1>
        </header>
        <LanguageSettings />
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
            <Button variant="ghost" size="icon-sm" aria-label={t('modelSettings.back')} onClick={onBack}><ArrowLeft /></Button>
          )}
          <div>
            <span className="text-[11px] font-bold tracking-[0.13em] text-muted-foreground uppercase">{t('modelSettings.eyebrow')}</span>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">{t('modelSettings.title')}</h1>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{t('modelSettings.description')}</p>
          </div>
        </div>
      </header>

      <LanguageSettings />
      <MobileNavigationSettings />

      {settingsQuery.isError ? (
        <div className="mt-8 flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <span>{settingsQuery.error instanceof Error ? settingsQuery.error.message : t('modelSettings.loadFailed')}</span>
          <Button size="sm" variant="outline" onClick={() => settingsQuery.refetch()}>{t('actions.retry')}</Button>
        </div>
      ) : (
        <div className="mt-8 border-t glass-divider pt-8">
          <form
            onSubmit={(event) => { event.preventDefault(); save.mutate(); }}
          >
            <div className="mb-4">
              <Label htmlFor="settings-base-url">{t('modelSettings.baseUrl')}</Label>
              <Input id="settings-base-url" required value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.openai.com/v1" />
            </div>
            <div className="mb-4">
              <Label htmlFor="settings-model">{t('modelSettings.model')}</Label>
              <Input id="settings-model" required value={model} onChange={(event) => setModel(event.target.value)} placeholder="gpt-4o-mini" />
            </div>
            <div className="mb-4">
              <Label htmlFor="settings-api-key">{t('modelSettings.apiKey')}</Label>
              <Input id="settings-api-key" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={settingsQuery.data?.apiKeyConfigured ? t('modelSettings.configuredPlaceholder', { masked: settingsQuery.data.apiKeyMasked ?? '' }) : t('modelSettings.enterKey')} autoComplete="new-password" />
            </div>
            <div className="glass-subtle mb-6 rounded-xl px-3.5 py-2.5 text-xs text-muted-foreground">
              {settingsQuery.data?.apiKeyConfigured ? <Trans ns="settings" i18nKey="modelSettings.currentKey" t={t} values={{ masked: settingsQuery.data.apiKeyMasked ?? '' }} components={{ code: <code className="font-mono text-foreground" /> }} /> : t('modelSettings.noApiKey')}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button disabled={save.isPending || clearKey.isPending}>{save.isPending ? t('modelSettings.testing') : t('modelSettings.testAndSave')}</Button>
              {settingsQuery.data?.apiKeyConfigured && (
                <Button type="button" variant="outline" className="text-destructive hover:bg-destructive/10 hover:text-destructive" disabled={save.isPending || clearKey.isPending} onClick={() => setClearKeyConfirmation(true)}>
                  {clearKey.isPending ? t('modelSettings.clearing') : t('modelSettings.clearKey')}
                </Button>
              )}
            </div>
          </form>
        </div>
      )}

      {!settingsQuery.isError && (
        <>
          <ImageSearchSettings />
          <HtmlBlockSettings />
          <section className="mt-10 border-t glass-divider pt-6">
            <h2 className="text-lg font-semibold">{t('skillsCard.title')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t('skillsCard.description')}</p>
            <Button variant="outline" className="mt-3" onClick={() => { window.location.hash = '/skills'; }}>{t('skillsCard.manage')}</Button>
          </section>
          <CliCommands settings={settingsQuery.data} />

          <BackupSection />

          <ServerInfo />
        </>
      )}

      {clearKeyConfirmation && (
        <ConfirmDialog
          title={t('modelSettings.clearKeyTitle')}
          itemName={t('modelSettings.clearKeyItem')}
          description={t('modelSettings.clearKeyDescription')}
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
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoreMode, setRestoreMode] = useState<'merge' | 'replace' | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const snapshotsQuery = useQuery<SnapshotEntry[]>({ queryKey: ['server-snapshots'], queryFn: () => api('/api/v1/server/snapshots') });

  async function download() {
    const response = await fetch('/api/v1/server/snapshot', { credentials: 'include', headers: authHeaders() });
    if (!response.ok) throw new Error(t('backup.downloadFailed', { status: response.status }));
    const disposition = response.headers.get('Content-Disposition') ?? '';
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `wwa-snapshot-${Date.now()}.zip`;
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
    toast.success(t('backup.downloadStarted'));
  }

  const restore = useMutation<void, Error, 'merge' | 'replace'>({
    mutationFn: async (mode) => {
      if (!restoreFile) throw new Error(t('backup.chooseFileFirst'));
      const response = await fetch(`/api/v1/server/snapshot/import?mode=${mode}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/zip', ...authHeaders() },
        body: restoreFile,
      });
      const body = await response.json().catch(() => ({ error: t('backup.badResponse') }));
      if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : t('backup.restoreFailed'));
      if (mode === 'merge') {
        const inserted = body.data?.inserted ?? 0;
        const skipped = body.data?.skipped ?? 0;
        toast.success(t('backup.merged', { inserted, skipped }));
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
      <h2 className="text-lg font-semibold">{t('backup.title')}</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{t('backup.description')}</p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" onClick={() => { void download().catch((error) => toast.error(error.message)); }}><Download className="size-4" />{t('backup.download')}</Button>
        <input ref={fileInput} id="restore-file" type="file" accept=".zip" className="hidden" onChange={(event) => setRestoreFile(event.target.files?.[0] ?? null)} />
        <Button type="button" variant="outline" disabled={!restoreFile || restore.isPending} onClick={() => setRestoreMode('merge')}>{restore.isPending && restoreMode === 'merge' ? t('backup.merging') : t('backup.merge')}</Button>
        <Button type="button" variant="outline" disabled={!restoreFile || restore.isPending} onClick={() => setRestoreMode('replace')}><RotateCcw className="size-4" />{restore.isPending && restoreMode === 'replace' ? t('backup.restoring') : t('backup.restore')}</Button>
        <Button type="button" variant="ghost" onClick={() => fileInput.current?.click()}>{restoreFile ? t('backup.selectedFile', { name: restoreFile.name }) : t('backup.chooseFile')}</Button>
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
          title={restoreMode === 'merge' ? t('backup.mergeTitle') : t('backup.restoreTitle')}
          itemName={restoreFile?.name ?? t('backup.selectedSnapshot')}
          description={restoreMode === 'merge'
            ? t('backup.mergeDescription')
            : t('backup.replaceDescription')}
          busy={restore.isPending}
          onCancel={() => { if (!restore.isPending) setRestoreMode(null); }}
          onConfirm={() => restore.mutate(restoreMode)}
        />
      )}
    </section>
  );
}

function ServerInfo() {
  const { t } = useTranslation('settings');
  const infoQuery = useQuery<ServerInfo>({ queryKey: ['server-info'], queryFn: () => api('/api/v1/server/info') });
  const inDesktopShell = typeof window !== 'undefined' && '__TAURI__' in window;
  if (infoQuery.isError) return null;
  const info = infoQuery.data;
  return (
    <section className="mt-10 border-t glass-divider pt-6">
      <h2 className="text-lg font-semibold">{t('server.title')}</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
        {info?.mode === 'server' ? t('server.serverMode') : t('server.localMode')}
      </p>
      <dl className="glass-subtle mt-4 grid gap-3 rounded-xl p-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted-foreground">{t('server.mode')}</dt>
          <dd className="mt-0.5">{info ? (info.mode === 'server' ? t('server.serverValue') : t('server.localValue')) : '…'}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('server.version')}</dt>
          <dd className="mt-0.5 font-mono">{info?.version ?? '…'}</dd>
        </div>
      </dl>
      {inDesktopShell && (
        <Button type="button" variant="outline" className="mt-4" onClick={() => { window.location.assign('/wwa-launcher'); }}>{t('server.switchMode')}</Button>
      )}
    </section>
  );
}

function CliCommands({ settings }: { settings?: Settings }) {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState({ codex: '', claude: '' });
  const [notice, setNotice] = useState('');
  const discover = useMutation({
    mutationFn: () => api<Settings>('/api/settings/cli/discover', { method: 'POST', body: '{}' }),
    onSuccess: (data) => {
      queryClient.setQueryData(['settings'], data);
      const pending = (['codex', 'claude'] as const).filter((provider) => data.discovered?.[provider] && data.cli?.[provider]?.source === 'manual' && data.discovered[provider].command && data.discovered[provider].command !== data.cli?.[provider]?.manualCommand);
      const missing = (['codex', 'claude'] as const).filter((provider) => data.discovered?.[provider]?.message);
      const found = pending.map((provider) => `${cliNames[provider]} ${data.discovered?.[provider]?.command}`).join(t('cli.listSeparator'));
      setNotice([pending.length ? t('cli.keptManual', { found }) : t('cli.discoverUpdated'), missing.map((provider) => data.discovered?.[provider]?.message).filter(Boolean).join(t('cli.messageSeparator'))].filter(Boolean).join(' '));
    },
    onError: (error: Error) => setNotice(error.message),
  });
  const saveManual = useMutation({
    mutationFn: (input: { provider: 'codex' | 'claude'; command: string }) => api<CliCommandSetting>('/api/settings/cli', { method: 'PUT', body: JSON.stringify(input) }),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['settings'] }); setNotice(t('cli.saved')); },
    onError: (error: Error) => setNotice(error.message),
  });
  const restore = useMutation({
    mutationFn: (provider: 'codex' | 'claude') => api<CliCommandSetting>(`/api/settings/cli/${provider}`, { method: 'DELETE' }),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['settings'] }); setNotice(t('cli.restored')); },
    onError: (error: Error) => setNotice(error.message),
  });
  return (
    <section className="mt-10 border-t glass-divider pt-6">
      <h2 className="text-lg font-semibold">{t('cli.title')}</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{t('cli.description')}</p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" disabled={discover.isPending} onClick={() => discover.mutate()}>{discover.isPending ? t('cli.checking') : t('cli.autoCheck')}</Button>
        {notice && <p className="text-xs text-muted-foreground">{notice}</p>}
      </div>
      {(['codex', 'claude'] as const).map((provider) => {
        const item = settings?.cli?.[provider];
        const source = item?.source === 'manual' ? t('cli.sourceManual') : item?.source === 'auto' ? t('cli.sourceAuto') : t('cli.sourceNone');
        return (
          <form key={provider} className="glass-subtle mt-4 space-y-3 rounded-xl p-4" onSubmit={(event) => { event.preventDefault(); saveManual.mutate({ provider, command: drafts[provider] || item?.command || '' }); }}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-medium">{cliNames[provider]}</h3>
              <span className="text-xs text-muted-foreground">{source}{item?.version ? ` · ${item.version}` : ''}</span>
            </div>
            <p className="break-all text-xs text-muted-foreground">{item?.command || t('cli.noCommand')}</p>
            <Label htmlFor={`cli-${provider}`}>{t('cli.commandPath')}</Label>
            <Input id={`cli-${provider}`} value={drafts[provider]} onChange={(event) => setDrafts((current) => ({ ...current, [provider]: event.target.value }))} placeholder={item?.command || (provider === 'codex' ? t('cli.codexPlaceholder') : t('cli.claudePlaceholder'))} />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" disabled={saveManual.isPending}>{t('cli.saveManual')}</Button>
              {item?.source === 'manual' && <Button type="button" size="sm" variant="outline" disabled={restore.isPending} onClick={() => restore.mutate(provider)}>{t('cli.restoreAuto')}</Button>}
            </div>
          </form>
        );
      })}
    </section>
  );
}
