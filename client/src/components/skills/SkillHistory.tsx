import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { intlLocale } from '@/i18n/index.js';
import { Button } from '@/components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';
import { MarkdownView } from '@/components/chat/MarkdownView.js';
import { DiffLines } from './SkillEditor.js';
import { formatSkillDiff, skillSourceLabel, type SkillDetail, type SkillDiff } from './skill-format.js';

type SkillVersion = { revision: number; name: string; description: string; instructions: string; enabled: boolean; reason: string; source: string; createdAt: string };

function VersionDialog({ skillId, revision, onClose }: { skillId: string; revision: number; onClose: () => void }) {
  const { t } = useTranslation('skills');
  const version = useQuery({ queryKey: ['skill', skillId, 'version', revision], queryFn: () => api<SkillVersion>(`/api/skills/${skillId}/versions/${revision}`) });
  const description = version.data
    ? `${version.data.description}${version.data.enabled ? '' : t('history.disabledNote')}`
    : t('action.reading');
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent surface="glass" className="flex max-h-[calc(100dvh-48px)] w-[min(720px,calc(100vw-32px))] max-w-none flex-col overflow-y-auto" data-testid="skill-version-dialog">
        <DialogHeader>
          <DialogTitle>{version.data ? `${version.data.name} v${revision}` : `v${revision}`}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {version.error && <p role="alert" className="text-sm text-destructive">{version.error.message}</p>}
        {version.data && <MarkdownView content={version.data.instructions} />}
        <DialogFooter><Button variant="outline" onClick={onClose}>{t('action.close')}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function SkillDiffView({ diff }: { diff: Pick<SkillDiff, 'fields' | 'lines'> }) {
  const { t } = useTranslation('skills');
  const view = formatSkillDiff(diff);
  const changed = view.lines.some((line) => line.type !== 'same');
  return (
    <div className="grid gap-2" data-testid="skill-diff">
      {view.fields.map((field) => <p key={field.key} className="text-sm"><span className="mr-2 text-muted-foreground">{field.label}</span><span className="line-through opacity-70">{field.before}</span><span aria-hidden="true" className="mx-1">→</span><span>{field.after}</span></p>)}
      {changed ? <DiffLines lines={view.lines} /> : <p className="text-sm text-muted-foreground">{t('history.bodyUnchanged')}</p>}
    </div>
  );
}

export function SkillHistory({ skill }: { skill: SkillDetail }) {
  const { t } = useTranslation('skills');
  const client = useQueryClient();
  const [picked, setPicked] = useState<number[]>([]);
  const [viewing, setViewing] = useState<number | null>(null);
  const [rollbackTo, setRollbackTo] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [from, to] = [...picked].sort((left, right) => left - right);
  const diff = useQuery({ queryKey: ['skill', skill.id, 'diff', from, to], queryFn: () => api<SkillDiff>(`/api/skills/${skill.id}/diff?from=${from}&to=${to}`), enabled: picked.length === 2 });
  const versions = [...skill.versions].sort((left, right) => right.revision - left.revision);
  const toggle = (revision: number) => setPicked((current) => current.includes(revision) ? current.filter((item) => item !== revision) : [...current, revision].slice(-2));
  const rollback = async () => {
    if (rollbackTo == null) return;
    setBusy(true);
    try {
      const saved = await api<SkillDetail>(`/api/skills/${skill.id}/rollback`, { method: 'POST', body: JSON.stringify({ expectedRevision: skill.revision, targetRevision: rollbackTo }) });
      await client.invalidateQueries({ queryKey: ['skills'] });
      await client.invalidateQueries({ queryKey: ['skill', skill.id] });
      toast.success(t('history.rolledBack', { revision: saved.revision }));
      setRollbackTo(null);
      setPicked([]);
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : t('history.rollbackFailed'));
    } finally { setBusy(false); }
  };
  return (
    <section aria-label={t('history.label')} className="grid gap-3">
      <div className="flex items-center gap-2"><h3 className="flex-1 font-semibold">{t('history.title')}</h3><span className="text-xs text-muted-foreground">{t('history.pickTwo')}</span></div>
      <ol className="glass-subtle divide-y divide-[var(--glass-divider)] overflow-hidden rounded-xl">
        {versions.map((version) => (
          <li key={version.revision} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm" data-testid="skill-version" data-revision={version.revision}>
            <input type="checkbox" aria-label={t('history.compare', { revision: version.revision })} checked={picked.includes(version.revision)} onChange={() => toggle(version.revision)} />
            <span className="font-medium">v{version.revision}</span>
            <span className="min-w-0 flex-1 truncate">{version.reason || t('history.noReason')}</span>
            <span className="text-xs text-muted-foreground">{skillSourceLabel(version.source)} · {new Date(version.createdAt).toLocaleString(intlLocale())}</span>
            <Button size="xs" variant="ghost" onClick={() => setViewing(version.revision)}>{t('action.view')}</Button>
            {!skill.deletedAt && version.revision !== skill.revision && <Button size="xs" variant="ghost" onClick={() => setRollbackTo(version.revision)}>{t('history.rollbackTo')}</Button>}
          </li>
        ))}
      </ol>
      {picked.length === 2 && <div className="grid gap-2"><h4 className="text-sm font-medium">v{from} → v{to}</h4>{diff.error ? <p role="alert" className="text-sm text-destructive">{diff.error.message}</p> : diff.data ? <SkillDiffView diff={diff.data} /> : <p className="text-sm text-muted-foreground">{t('history.comparing')}</p>}</div>}
      {viewing != null && <VersionDialog skillId={skill.id} revision={viewing} onClose={() => setViewing(null)} />}
      {rollbackTo != null && (
        <Dialog open onOpenChange={(open) => { if (!open && !busy) setRollbackTo(null); }}>
          <DialogContent showCloseButton={false} surface="glass">
            <DialogHeader><DialogTitle>{t('history.rollbackTitle', { revision: rollbackTo })}</DialogTitle><DialogDescription>{t('history.rollbackDescription', { revision: rollbackTo, next: skill.revision + 1 })}</DialogDescription></DialogHeader>
            <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setRollbackTo(null)}>{t('action.cancel')}</Button><Button disabled={busy} onClick={() => void rollback()}>{busy ? t('history.rollingBack') : t('history.confirmRollback')}</Button></DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}
