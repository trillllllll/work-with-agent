import { Surface } from '@/components/ui/surface.js';
import { Badge } from '@/components/ui/badge.js';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, type ContextWindowProbe, type ModelProfile, type Settings } from '@/lib/api.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Label } from '@/components/ui/label.js';
import { Skeleton } from '@/components/ui/skeleton.js';
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog.js';
import { FormDialog } from '@/components/dialogs/FormDialog.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.js';
import { ModelPicker } from '@/components/settings/ModelPicker.js';
import { ChevronDown, Copy, Loader2, MoreHorizontal, Plus, Trash2 } from 'lucide-react';
import { cn } from 'cn';

/** Shared by every block that reads `/api/settings`; the same query key keeps one request. */
export function useSettingsQuery() {
  return useQuery<Settings>({ queryKey: ['settings'], queryFn: () => api('/api/settings') });
}

/** Error row for blocks that depend on `/api/settings`. Other blocks keep working when it fails. */
export function SettingsLoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useTranslation('settings');
  return (
    <div role="alert" className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
      <span>{error instanceof Error ? error.message : t('modelSettings.loadFailed')}</span>
      <Button size="sm" variant="outline" onClick={onRetry}>{t('actions.retry')}</Button>
    </div>
  );
}

const fmtWindow = (value: number) => (value >= 1000 ? `${Math.round(value / 1000)}K` : String(value));

export function ModelSettings() {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const settingsQuery = useSettingsQuery();
  const [editor, setEditor] = useState<{ profile: ModelProfile | null } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ModelProfile | null>(null);
  const publish = (data: Settings) => queryClient.setQueryData(['settings'], data);
  const profiles = settingsQuery.data?.profiles ?? [];
  const active = profiles.find((profile) => profile.id === settingsQuery.data?.activeProfileId) ?? profiles[0];

  const activate = useMutation({
    mutationFn: (profile: ModelProfile) => api<Settings>(`/api/settings/profiles/${profile.id}/activate`, { method: 'POST' }),
    onSuccess: (data, profile) => { publish(data); toast.success(t('modelSettings.activatedToast', { name: profile.name, model: profile.model })); },
    onError: (error: Error) => toast.error(error.message),
  });
  const copy = useMutation({
    mutationFn: (profile: ModelProfile) => api<Settings>(`/api/settings/profiles/${profile.id}/copy`, { method: 'POST' }),
    onSuccess: (data, profile) => { publish(data); toast.success(t('modelSettings.duplicatedToast', { name: `${profile.name} 副本` })); },
    onError: (error: Error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: (profile: ModelProfile) => api<Settings>(`/api/settings/profiles/${profile.id}`, { method: 'DELETE' }),
    onSuccess: (data, profile) => {
      publish(data);
      setDeleteTarget(null);
      const fallback = profile.id === settingsQuery.data?.activeProfileId && data.activeProfileId !== profile.id;
      toast.success(fallback ? t('modelSettings.deletedFallbackToast', { name: data.profiles?.find((item) => item.id === data.activeProfileId)?.name ?? '' }) : t('modelSettings.deletedToast'));
    },
    onError: (error: Error) => { setDeleteTarget(null); toast.error(error.message); },
  });
  const pickModel = useMutation({
    mutationFn: ({ id, model }: { id: string; model: string }) => api<Settings>(`/api/settings/profiles/${id}`, { method: 'PATCH', body: JSON.stringify({ model }) }),
    onSuccess: (data, vars) => { publish(data); toast.success(t('modelSettings.modelSwitched', { model: vars.model })); },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <section aria-labelledby="settings-model-title">
      <h3 id="settings-model-title" className="text-lg font-semibold">{t('modelSettings.title')}</h3>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{t('modelSettings.description')}</p>
      {settingsQuery.isLoading ? (
        <div className="mt-4" aria-busy="true">
          <Skeleton className="h-28 w-full rounded-xl" />
          <Skeleton className="mt-3 h-28 w-full rounded-xl" />
        </div>
      ) : settingsQuery.isError ? (
        <SettingsLoadError error={settingsQuery.error} onRetry={() => void settingsQuery.refetch()} />
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <p className="text-xs text-muted-foreground">{profiles.length ? t('modelSettings.profilesSummary', { count: profiles.length, name: active?.name ?? '' }) : t('modelSettings.noProfilesHint')}</p>
            <Button variant="outline" size="sm" className="ml-auto" onClick={() => setEditor({ profile: null })}>
              <Plus className="size-3.5" aria-hidden="true" />
              {t('modelSettings.createProfile')}
            </Button>
          </div>
          <div className="mt-3 space-y-3">
            {profiles.map((profile) => (
              <ProfileCard
                key={profile.id}
                profile={profile}
                active={profile.id === active?.id}
                busy={activate.isPending || pickModel.isPending}
                last={profiles.length <= 1}
                onActivate={() => activate.mutate(profile)}
                onEdit={() => setEditor({ profile })}
                onDuplicate={() => copy.mutate(profile)}
                onDelete={() => setDeleteTarget(profile)}
                onPickModel={(model) => pickModel.mutate({ id: profile.id, model })}
              />
            ))}
          </div>
        </>
      )}
      {editor && (
        <ProfileEditorDialog
          profile={editor.profile}
          onClose={() => setEditor(null)}
          onSaved={(data) => { publish(data); setEditor(null); toast.success(t('modelSettings.saved')); }}
        />
      )}
      {deleteTarget && (
        <ConfirmDialog
          title={t('modelSettings.deleteTitle')}
          itemName={deleteTarget.name}
          description={t('modelSettings.deleteDescription')}
          busy={remove.isPending}
          confirmLabel={t('modelSettings.deleteConfirm')}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => remove.mutate(deleteTarget)}
        >
          <p className="mt-3 font-mono text-xs text-muted-foreground">{deleteTarget.baseUrl} · {deleteTarget.model}</p>
          {deleteTarget.id === active?.id && profiles.length > 1 && <p className="mt-2 text-xs text-warning">{t('modelSettings.deleteActiveWarning')}</p>}
        </ConfirmDialog>
      )}
    </section>
  );
}

type ProfileCardProps = {
  profile: ModelProfile;
  active: boolean;
  busy: boolean;
  last: boolean;
  onActivate: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onPickModel: (model: string) => void;
};

function ProfileCard({ profile, active, busy, last, onActivate, onEdit, onDuplicate, onDelete, onPickModel }: ProfileCardProps) {
  const { t } = useTranslation('settings');
  return (
    <Surface as="article" tone="subtle" className={cn('rounded-xl p-4', active && 'border-primary/35 bg-accent/40')}>
      <header className="flex min-w-0 flex-wrap items-center gap-2">
        <h4 className="min-w-0 truncate text-[15px] font-semibold">{profile.name}</h4>
        {active ? (
          <Badge className="shrink-0">{t('modelSettings.activeBadge')}</Badge>
        ) : (
          <Button variant="outline" size="sm" disabled={busy} onClick={onActivate}>{t('modelSettings.setActive')}</Button>
        )}
        <span className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={onEdit}>{t('modelSettings.editProfile')}</Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t('modelSettings.moreActions')} disabled={busy && last}>
                <MoreHorizontal className="size-4" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onDuplicate}>
                <Copy aria-hidden="true" />
                {t('modelSettings.duplicate')}
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" disabled={last} onClick={onDelete}>
                <Trash2 aria-hidden="true" />
                {t('modelSettings.deleteAction')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </header>
      <dl className="mt-2.5 grid grid-cols-[72px_1fr] items-baseline gap-x-3 gap-y-1.5 text-[13px]">
        <dt className="text-xs text-muted-foreground">{t('modelSettings.baseUrl')}</dt>
        <dd className="min-w-0 break-all font-mono text-xs text-muted-foreground">{profile.baseUrl}</dd>
        <dt className="text-xs text-muted-foreground">{t('modelSettings.model')}</dt>
        <dd className="min-w-0">
          <span className="flex items-center gap-2">
            <ModelPicker profileId={profile.id} value={profile.model} onPick={onPickModel}>
              <button
                type="button"
                className="-mx-1.5 inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 font-mono text-[13px] transition-colors hover:bg-accent disabled:opacity-50"
                disabled={busy}
                title={t('modelSettings.modelFetch')}
              >
                {profile.model}
                <ChevronDown className="size-3 text-muted-foreground" aria-hidden="true" />
              </button>
            </ModelPicker>
            <span className="text-[11px] text-muted-foreground">{t('modelSettings.modelFetchHint')}</span>
          </span>
        </dd>
        <dt className="text-xs text-muted-foreground">{t('modelSettings.contextWindowLabel')}</dt>
        <dd className="min-w-0 font-mono text-[13px]">
          {profile.contextWindow ? (
            <Trans t={t} i18nKey="modelSettings.contextWindowValue" values={{ window: fmtWindow(profile.contextWindow) }} components={{ mono: <span className="font-mono" /> }} />
          ) : (
            <span className="text-muted-foreground">{t('modelSettings.contextWindowUnknown')}</span>
          )}
        </dd>
        <dt className="text-xs text-muted-foreground">{t('modelSettings.apiKey')}</dt>
        <dd className="min-w-0 text-[13px]">
          {profile.apiKeyConfigured ? <span className="font-mono text-xs">{profile.apiKeyMasked}</span> : <span className="text-warning">{t('modelSettings.keyMissing')}</span>}
        </dd>
      </dl>
    </Surface>
  );
}

type ProfileEditorDialogProps = {
  profile: ModelProfile | null;
  onClose: () => void;
  onSaved: (data: Settings) => void;
};

/** 新建 / 编辑一套配置：服务端在写入前会先做连接测试。 */
function ProfileEditorDialog({ profile, onClose, onSaved }: ProfileEditorDialogProps) {
  const { t } = useTranslation('settings');
  const [nameDraft, setNameDraft] = useState(profile?.name ?? '');
  const [baseUrlDraft, setBaseUrlDraft] = useState(profile?.baseUrl ?? '');
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [modelDraft, setModelDraft] = useState(profile?.model ?? '');
  const [windowDraft, setWindowDraft] = useState(profile?.contextWindow ? String(profile.contextWindow) : '');
  const save = useMutation({
    mutationFn: () => {
      const payload = { name: nameDraft.trim(), baseUrl: baseUrlDraft.trim(), model: modelDraft.trim(), contextWindow: windowDraft.trim() ? Number(windowDraft.trim()) : null, ...(apiKeyDraft.trim() ? { apiKey: apiKeyDraft.trim() } : {}) };
      return profile
        ? api<Settings>(`/api/settings/profiles/${profile.id}`, { method: 'PATCH', body: JSON.stringify(payload) })
        : api<Settings>('/api/settings/profiles', { method: 'POST', body: JSON.stringify({ ...payload, apiKey: apiKeyDraft.trim() }) });
    },
    onSuccess: onSaved,
    onError: (error: Error) => toast.error(error.message),
  });
  // 先填接口地址和模型再读窗口；编辑已配置档案时 Key 留空则走服务端保存的那把。
  const probe = useMutation<ContextWindowProbe, Error, void>({
    mutationFn: () => api('/api/settings/context-window/probe', { method: 'POST', body: JSON.stringify({ baseUrl: baseUrlDraft.trim(), model: modelDraft.trim(), ...(apiKeyDraft.trim() ? { apiKey: apiKeyDraft.trim() } : {}) }) }),
    onSuccess: (data) => {
      if (data.contextWindow) {
        setWindowDraft(String(data.contextWindow));
        toast.success(t('modelSettings.contextWindowFetched', { model: data.model, window: data.contextWindow }));
      } else {
        toast.error(t(`modelSettings.contextWindowFetchMiss.${data.reason}`, { status: data.status ?? '' }));
      }
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <FormDialog title={profile ? t('modelSettings.editTitle') : t('modelSettings.createTitle')} description={t('modelSettings.editorDescription')} onClose={onClose}>
      <form onSubmit={(event) => { event.preventDefault(); if (!save.isPending) save.mutate(); }}>
        <div className="mb-4">
          <Label htmlFor="settings-profile-name">{t('modelSettings.nameLabel')}</Label>
          <Input id="settings-profile-name" required maxLength={60} value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} placeholder={t('modelSettings.namePlaceholder')} />
        </div>
        <div className="mb-4">
          <Label htmlFor="settings-profile-url">{t('modelSettings.baseUrl')}</Label>
          <Input id="settings-profile-url" required value={baseUrlDraft} onChange={(event) => setBaseUrlDraft(event.target.value)} placeholder="https://api.openai.com/v1" className="font-mono" />
        </div>
        <div className="mb-4">
          <Label htmlFor="settings-profile-key">{t('modelSettings.apiKey')}</Label>
          <Input
            id="settings-profile-key"
            type="password"
            value={apiKeyDraft}
            onChange={(event) => setApiKeyDraft(event.target.value)}
            placeholder={profile?.apiKeyConfigured ? t('modelSettings.configuredPlaceholder', { masked: profile.apiKeyMasked ?? '' }) : t('modelSettings.enterKey')}
            autoComplete="new-password"
          />
          {profile?.apiKeyConfigured && (
            <p className="mt-1.5 text-xs text-muted-foreground">
              <Trans ns="settings" i18nKey="modelSettings.currentKey" t={t} values={{ masked: profile.apiKeyMasked ?? '' }} components={{ code: <code className="font-mono text-foreground" /> }} />
            </p>
          )}
        </div>
        <div className="mb-4">
          <Label htmlFor="settings-profile-model">{t('modelSettings.model')}</Label>
          <div className="flex gap-2">
            <Input id="settings-profile-model" required value={modelDraft} onChange={(event) => setModelDraft(event.target.value)} placeholder="gpt-4o-mini" className="min-w-0 font-mono" />
            <ModelPicker
              baseUrl={baseUrlDraft}
              apiKey={apiKeyDraft}
              profileId={profile?.apiKeyConfigured ? profile.id : undefined}
              value={modelDraft}
              onPick={(model, contextWindow) => { setModelDraft(model); if (contextWindow && !windowDraft) setWindowDraft(String(contextWindow)); }}
            >
              <Button type="button" variant="outline" className="shrink-0">
                {t('modelSettings.modelFetch')}
                <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden="true" />
              </Button>
            </ModelPicker>
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">{t('modelSettings.modelPickerHint')}</p>
        </div>
        <div className="mb-2">
          <Label htmlFor="settings-profile-window">{t('modelSettings.contextWindow')}</Label>
          <div className="flex gap-2">
            <Input
              id="settings-profile-window"
              type="number"
              inputMode="numeric"
              min={1024}
              max={10000000}
              step={1}
              value={windowDraft}
              onChange={(event) => setWindowDraft(event.target.value)}
              placeholder={t('modelSettings.contextWindowPlaceholder')}
              aria-describedby="settings-profile-window-hint"
              className="min-w-0"
            />
            <Button
              type="button"
              variant="outline"
              className="shrink-0"
              disabled={!baseUrlDraft.trim() || !modelDraft.trim() || probe.isPending || save.isPending}
              onClick={() => probe.mutate()}
            >
              {probe.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
              {t('modelSettings.contextWindowFetch')}
            </Button>
          </div>
          <p id="settings-profile-window-hint" className="mt-1.5 text-xs text-muted-foreground">{t('modelSettings.contextWindowHint')}</p>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>{t('actions.cancel')}</Button>
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
            {save.isPending ? t('modelSettings.testing') : t('modelSettings.testAndSave')}
          </Button>
        </div>
      </form>
    </FormDialog>
  );
}
