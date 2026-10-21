import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, FileUp, Plus } from 'lucide-react';
import { api, ApiError } from '@/lib/api.js';
import { usePageContext } from '@/lib/assistant-context.js';
import { intlLocale } from '@/i18n/index.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog.js';
import { MarkdownView } from '@/components/chat/MarkdownView.js';
import { cn } from '@/lib/utils.js';
import { SkillHistory } from './SkillHistory.js';
import { openSkillEditor, skillImportErrorText, skillOriginLabel, type SkillDetail, type SkillListItem } from './skill-format.js';

type StatusFilter = 'all' | 'enabled' | 'disabled' | 'deleted';
type ImportConflict = { markdown: string; draft: { name: string; description: string }; skillId: string; revision: number };

function listPath(q: string, status: StatusFilter, origin: string) {
  const params = new URLSearchParams();
  if (q.trim()) params.set('q', q.trim());
  if (status === 'enabled') params.set('enabled', 'true');
  if (status === 'disabled') params.set('enabled', 'false');
  if (status === 'deleted') params.set('deleted', 'true');
  if (origin) params.set('origin', origin);
  const query = params.toString();
  return `/api/skills${query ? `?${query}` : ''}`;
}

function ImportConflictDialog({ conflict, onClose, onDone }: { conflict: ImportConflict; onClose: () => void; onDone: (skill: SkillDetail) => void }) {
  const { t } = useTranslation('skills');
  const [name, setName] = useState(t('import.nameSuffix', { name: conflict.draft.name }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (resolution: 'version' | 'rename') => {
    setBusy(true);
    setError('');
    try {
      const body = resolution === 'version' ? { markdown: conflict.markdown, resolution, expectedRevision: conflict.revision } : { markdown: conflict.markdown, resolution, name: name.trim() };
      onDone(await api<SkillDetail>('/api/skills/import', { method: 'POST', body: JSON.stringify(body) }));
    } catch (failure) {
      setError(failure instanceof ApiError && failure.code === 'SKILL_NAME_TAKEN' ? t('import.nameTaken') : failure instanceof Error ? failure.message : t('import.failed'));
    } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent surface="glass" data-testid="skill-import-conflict">
        <DialogHeader><DialogTitle>{t('import.title', { name: conflict.draft.name })}</DialogTitle><DialogDescription>{t('import.description')}</DialogDescription></DialogHeader>
        <label className="grid gap-1 text-sm">{t('import.newName')}<Input aria-label={t('import.nameLabel')} value={name} maxLength={80} onChange={(event) => setName(event.target.value)} /></label>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>{t('action.cancel')}</Button>
          <Button variant="outline" disabled={busy || !name.trim()} onClick={() => void submit('rename')}>{t('import.rename')}</Button>
          <Button disabled={busy} onClick={() => void submit('version')}>{t('import.overwrite')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type DetailTab = 'body' | 'history';

function SkillDetailView({ id, onBack }: { id: string; onBack: () => void }) {
  const { t } = useTranslation('skills');
  const client = useQueryClient();
  const detail = useQuery({ queryKey: ['skill', id], queryFn: () => api<SkillDetail>(`/api/skills/${id}`) });
  const [tab, setTab] = useState<DetailTab>('body');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const skill = detail.data;
  const refresh = async () => { await client.invalidateQueries({ queryKey: ['skills'] }); await client.invalidateQueries({ queryKey: ['skill', id] }); };
  const act = async (work: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try { await work(); await refresh(); toast.success(message); return true; }
    catch (failure) { toast.error(failure instanceof ApiError && failure.code === 'VERSION_CONFLICT' ? t('page.versionConflict') : failure instanceof Error ? failure.message : t('action.failed')); await refresh(); return false; }
    finally { setBusy(false); }
  };
  if (detail.error) return <p role="alert" className="p-4 text-sm text-destructive">{detail.error.message}</p>;
  if (!skill) return <p className="p-4 text-sm text-muted-foreground">{t('action.loading')}</p>;
  const status = skill.deletedAt ? t('state.deleted') : skill.enabled ? t('state.enabledStatus') : t('state.disabledStatus');
  const toggleEnabled = () => act(() => api(`/api/skills/${skill.id}`, { method: 'PATCH', body: JSON.stringify({ expectedRevision: skill.revision, enabled: !skill.enabled }) }), skill.enabled ? t('page.disabledToast') : t('page.enabledToast'));
  const tabClass = (selected: boolean) => cn('shrink-0 rounded-full px-3 py-1 text-sm', selected ? 'bg-primary text-primary-foreground' : 'text-muted-foreground');
  return (
    <article className="flex min-h-0 flex-1 flex-col gap-3" aria-label={t('page.detailLabel', { name: skill.name })} data-testid="skill-detail">
      <Button variant="ghost" size="sm" className="shrink-0 self-start @3xl:hidden" onClick={onBack}><ArrowLeft />{t('page.backToList')}</Button>
      <header className="flex shrink-0 flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-semibold break-words">{skill.name}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{t('page.meta', { revision: skill.revision, origin: skillOriginLabel(skill.origin), status, time: new Date(skill.updatedAt).toLocaleString(intlLocale()) })}</p>
        </div>
        {skill.deletedAt
          ? <Button size="sm" disabled={busy} onClick={() => void act(() => api(`/api/skills/${skill.id}/restore`, { method: 'POST', body: '{}' }), t('page.restored'))}>{t('action.restore')}</Button>
          : (
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground"><input type="checkbox" role="switch" aria-label={t('page.enableNamed', { name: skill.name })} checked={skill.enabled} disabled={busy} onChange={() => void toggleEnabled()} />{skill.enabled ? t('state.enabled') : t('state.disabled')}</label>
              <Button size="sm" variant="outline" onClick={() => openSkillEditor({ skillId: skill.id })}>{t('action.edit')}</Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirmDelete(true)}>{t('action.delete')}</Button>
            </div>
          )}
      </header>
      <p className="shrink-0 text-sm">{skill.description}</p>
      <div role="tablist" aria-label={t('page.detailTabs')} className="flex shrink-0 gap-2">
        <button type="button" role="tab" aria-selected={tab === 'body'} data-testid="skill-tab-body" className={tabClass(tab === 'body')} onClick={() => setTab('body')}>{t('field.body')}</button>
        <button type="button" role="tab" aria-selected={tab === 'history'} data-testid="skill-tab-history" className={tabClass(tab === 'history')} onClick={() => setTab('history')}>{t('history.title')}</button>
      </div>
      {tab === 'body'
        ? <div role="tabpanel" className="glass-subtle glass-scrollbar min-h-0 overflow-y-auto rounded-xl p-4" data-testid="skill-instructions"><MarkdownView content={skill.instructions} /></div>
        : <div role="tabpanel" className="glass-scrollbar min-h-0 overflow-y-auto"><SkillHistory skill={skill} /></div>}
      {confirmDelete && <ConfirmDialog title={t('page.deleteTitle')} itemName={skill.name} description={t('page.deleteDescription')} busy={busy} onCancel={() => setConfirmDelete(false)} onConfirm={() => void act(() => api(`/api/skills/${skill.id}?expectedRevision=${skill.revision}`, { method: 'DELETE' }), t('page.deletedToast')).then((ok) => { setConfirmDelete(false); if (ok) onBack(); })} />}
    </article>
  );
}

export function SkillsPage() {
  const { t } = useTranslation('skills');
  const client = useQueryClient();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [origin, setOrigin] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [conflict, setConflict] = useState<ImportConflict | null>(null);
  const [toggling, setToggling] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  usePageContext('skills', { pageState: { status, kind: origin, query: q, selectedId } });
  const list = useQuery({ queryKey: ['skills', q, status, origin], queryFn: () => api<SkillListItem[]>(listPath(q, status, origin)) });
  const skills = list.data ?? [];

  const toggle = async (skill: SkillListItem) => {
    setToggling(skill.id);
    try {
      await api(`/api/skills/${skill.id}`, { method: 'PATCH', body: JSON.stringify({ expectedRevision: skill.revision, enabled: !skill.enabled }) });
      toast.success(skill.enabled ? t('page.disabledToast') : t('page.enabledToast'));
    } catch (failure) {
      toast.error(failure instanceof ApiError && failure.code === 'VERSION_CONFLICT' ? t('page.versionConflict') : failure instanceof Error ? failure.message : t('action.failed'));
    } finally {
      setToggling('');
      await client.invalidateQueries({ queryKey: ['skills'] });
      await client.invalidateQueries({ queryKey: ['skill', skill.id] });
    }
  };

  const imported = async (skill: SkillDetail) => {
    setConflict(null);
    await client.invalidateQueries({ queryKey: ['skills'] });
    await client.invalidateQueries({ queryKey: ['skill', skill.id] });
    setSelectedId(skill.id);
    toast.success(skill.revision === 1 ? t('import.importedNew') : t('import.importedVersion', { revision: skill.revision }));
  };

  const importFile = async (file: File) => {
    const markdown = await file.text();
    try {
      await imported(await api<SkillDetail>('/api/skills/import', { method: 'POST', body: JSON.stringify({ markdown }) }));
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === 'SKILL_NAME_TAKEN') {
        const details = (failure.details ?? {}) as { skillId?: string; revision?: number; draft?: { name: string; description: string } };
        if (details.skillId && details.revision && details.draft) { setConflict({ markdown, draft: details.draft, skillId: details.skillId, revision: details.revision }); return; }
      }
      if (failure instanceof ApiError && failure.code === 'SKILL_MARKDOWN_INVALID') { toast.error(skillImportErrorText(failure)); return; }
      toast.error(failure instanceof Error ? failure.message : t('import.failed'));
    }
  };

  const empty = status === 'deleted' ? t('page.emptyDeleted') : q || origin || status !== 'all' ? t('page.emptyFiltered') : t('page.empty');
  return (
    <section className="@container mx-auto flex h-full max-w-6xl min-h-[30rem] flex-col gap-4 p-5 sm:p-7" aria-label={t('page.label')}>
      <header className="flex shrink-0 flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold">{t('page.title')}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t('page.subtitle')}</p>
        </div>
        <Button variant="outline" onClick={() => fileRef.current?.click()}><FileUp />{t('import.button')}</Button>
        <Button onClick={() => openSkillEditor({})}><Plus />{t('action.create')}</Button>
        <input ref={fileRef} type="file" accept=".md,text/markdown,text/plain" className="hidden" data-testid="skill-import-input" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importFile(file); }} />
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] gap-5 @3xl:grid-cols-[minmax(240px,320px)_minmax(0,1fr)]">
        <div className={cn('flex min-h-0 min-w-0 flex-col gap-3', selectedId && 'hidden @3xl:flex')}>
          <Input aria-label={t('page.searchLabel')} placeholder={t('page.searchPlaceholder')} value={q} onChange={(event) => setQ(event.target.value)} />
          <div className="flex gap-2">
            <select aria-label={t('page.statusLabel')} className="glass-control h-9 min-w-0 flex-1 rounded-lg px-3 text-sm" value={status} onChange={(event) => { setStatus(event.target.value as StatusFilter); setSelectedId(''); }}>
              <option value="all">{t('page.statusAll')}</option><option value="enabled">{t('state.enabledStatus')}</option><option value="disabled">{t('state.disabledStatus')}</option><option value="deleted">{t('state.deleted')}</option>
            </select>
            <select aria-label={t('page.originLabel')} className="glass-control h-9 min-w-0 flex-1 rounded-lg px-3 text-sm" value={origin} onChange={(event) => setOrigin(event.target.value)}>
              <option value="">{t('page.originAll')}</option><option value="manual">{t('origin.manual')}</option><option value="import">{t('origin.import')}</option><option value="assistant">{t('origin.assistant')}</option>
            </select>
          </div>
          {list.error && <p role="alert" className="text-sm text-destructive">{list.error.message}</p>}
          {list.isLoading ? <p className="text-sm text-muted-foreground">{t('action.loading')}</p> : !skills.length ? <p className="py-8 text-sm text-muted-foreground">{empty}</p> : (
            <ul aria-label={t('page.listLabel')} className="glass-scrollbar glass-subtle min-h-0 divide-y divide-[var(--glass-divider)] overflow-y-auto rounded-xl">
              {skills.map((skill) => (
                <li key={skill.id} data-testid="skill-row" data-skill-name={skill.name} className={cn('flex items-start gap-2 px-3 py-2.5', selectedId === skill.id && 'bg-[color-mix(in_srgb,var(--foreground)_8%,transparent)]')}>
                  <button type="button" className="min-w-0 flex-1 text-left" aria-current={selectedId === skill.id ? 'true' : undefined} onClick={() => setSelectedId(skill.id)}>
                    <span className="flex items-center gap-2"><span className="truncate font-medium">{skill.name}</span><span className="shrink-0 text-[11px] text-muted-foreground">v{skill.revision}</span></span>
                    <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">{skill.description}</span>
                    <span className="mt-1 block text-[11px] text-muted-foreground">{skillOriginLabel(skill.origin)} · {new Date(skill.updatedAt).toLocaleDateString(intlLocale())}</span>
                  </button>
                  {!skill.deletedAt && <label className="flex shrink-0 items-center gap-1 pt-0.5 text-xs text-muted-foreground"><input type="checkbox" role="switch" aria-label={t('page.enableNamed', { name: skill.name })} checked={skill.enabled} disabled={toggling === skill.id} onChange={() => void toggle(skill)} />{skill.enabled ? t('state.enabled') : t('state.disabled')}</label>}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className={cn('flex min-h-0 min-w-0 flex-col', !selectedId && 'hidden @3xl:flex')}>
          {selectedId ? <SkillDetailView key={selectedId} id={selectedId} onBack={() => setSelectedId('')} /> : <p className="py-8 text-sm text-muted-foreground">{t('page.selectHint')}</p>}
        </div>
      </div>
      {conflict && <ImportConflictDialog conflict={conflict} onClose={() => setConflict(null)} onDone={(skill) => void imported(skill)} />}
    </section>
  );
}
