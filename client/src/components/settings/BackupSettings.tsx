import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Download, RotateCcw } from 'lucide-react';
import { api, authHeaders } from '@/lib/api.js';
import { Button } from '@/components/ui/button.js';
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog.js';

export type SnapshotEntry = { name: string; size: number; createdAt: string };

function formatBytes(size: number) {
  if (size >= 1_048_576) return `${(size / 1_048_576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(size / 1_024))} KB`;
}

export const snapshotsQueryOptions = { queryKey: ['server-snapshots'], queryFn: () => api<SnapshotEntry[]>('/api/v1/server/snapshots') };

export function BackupSettings() {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoreMode, setRestoreMode] = useState<'merge' | 'replace' | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const snapshotsQuery = useQuery<SnapshotEntry[]>(snapshotsQueryOptions);

  async function download() {
    const response = await fetch('/api/v1/server/snapshot', { credentials: 'include', headers: authHeaders() });
    if (!response.ok) throw new Error(t('backup.downloadFailed', { status: response.status }));
    const disposition = response.headers.get('Content-Disposition') ?? '';
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `dovun-snapshot-${Date.now()}.zip`;
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
    <section aria-labelledby="settings-backup-title">
      <h3 id="settings-backup-title" className="text-lg font-semibold">{t('backup.title')}</h3>
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
