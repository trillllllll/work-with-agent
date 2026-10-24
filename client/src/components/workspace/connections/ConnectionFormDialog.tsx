import { Checkbox } from '@/components/ui/checkbox.js';
import { useState, type FormEvent } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Eye, EyeOff, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import type { Topic } from '@/lib/api.js';
import { parseStored } from '@/lib/platform.js';
import { hostLabel, type Connection } from '@/lib/connection-status.js';
import { setupSnippet, type ConnectionConfiguration } from '@/lib/connection-snippet.js';
import { topicIdsForSave } from '@/lib/scope-selection.js';
import { Button } from '@/components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';
import { Input } from '@/components/ui/input.js';
import { AccessPicker } from './AccessPicker.js';
import { AutoActionSwitches, connectionOperationIds } from './AutoActionSwitches.js';
import { HostPicker } from './HostPicker.js';

export type CreatedConnection = Connection & { token: string; configuration: ConnectionConfiguration };

export type ConnectionDraft = {
  name: string;
  host: string;
  topicIds: string[];
  includeInbox: boolean;
  autoActions: string[];
};

type ConnectionFormMode =
  | { kind: 'create'; host: string }
  | { kind: 'edit'; connection: Connection }
  | { kind: 'setup'; created: CreatedConnection };

type ConnectionFormDialogProps = {
  mode: ConnectionFormMode;
  topics: Topic[];
  archivedTopics: Topic[];
  onClose: () => void;
  onCreate: (draft: ConnectionDraft) => Promise<void>;
  onSave: (draft: Omit<ConnectionDraft, 'host'>) => Promise<void>;
};

const dialogClass = 'flex max-h-[85dvh] min-h-0 w-full max-w-[min(40rem,calc(100%-3rem))] flex-col gap-0 overflow-hidden p-0 max-lg:inset-0! max-lg:top-0! max-lg:left-0! max-lg:h-dvh! max-lg:max-h-none! max-lg:w-full! max-lg:max-w-none! max-lg:translate-x-0! max-lg:translate-y-0! max-lg:rounded-none!';

export function ConnectionFormDialog({ mode, topics, archivedTopics, onClose, onCreate, onSave }: ConnectionFormDialogProps) {
  const { t } = useTranslation('workspace');
  const editing = mode.kind === 'edit' ? mode.connection : null;
  const created = mode.kind === 'setup' ? mode.created : null;
  const [name, setName] = useState(editing?.name ?? '');
  const [host, setHost] = useState(editing?.host ?? (mode.kind === 'create' ? mode.host : created?.host ?? 'codex'));
  const [includeInbox, setIncludeInbox] = useState(editing?.includeInbox ?? false);
  const [topicIds, setTopicIds] = useState<string[]>(() => editing ? parseStored<string[]>(editing.topicIds, []) : []);
  const [autoActions, setAutoActions] = useState<string[]>(() => editing ? parseStored<string[]>(editing.autoActions, []).filter((id) => (connectionOperationIds as readonly string[]).includes(id)) : []);
  const [busy, setBusy] = useState(false);
  const missingIds = editing?.missingTopicIds ?? [];
  const missingChecked = topicIds.filter((id) => missingIds.includes(id));
  const missingName = !name.trim();
  const missingScope = !includeInbox && topicIdsForSave(topicIds, missingIds).length === 0;
  const blocked = missingChecked.length > 0;
  const ready = !missingName && !missingScope && !blocked;
  const hint = blocked
    ? t('connections.missingBlocked', { count: missingChecked.length })
    : missingName
      ? t('connections.missingName')
      : missingScope
        ? t('connections.missingScope')
        : editing ? t('connections.readyToSave') : t('connections.ready');
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !ready) return;
    setBusy(true);
    const draft = { name: name.trim(), topicIds: topicIdsForSave(topicIds, missingIds), includeInbox, autoActions: connectionOperationIds.filter((id) => autoActions.includes(id)) };
    try {
      if (editing) await onSave(draft);
      else await onCreate({ ...draft, host });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent surface="glass" className={dialogClass} onInteractOutside={(event) => { if (created) event.preventDefault(); }} onEscapeKeyDown={(event) => { if (created) event.preventDefault(); }} onOpenAutoFocus={(event) => { if (!editing) return; event.preventDefault(); (event.currentTarget as HTMLElement).focus(); }}>
        <DialogHeader className="shrink-0 border-b glass-divider px-5 py-4 text-left">
          {created ? (
            <>
              <p className="text-xs text-muted-foreground">{t('connections.stepSetup')}</p>
              <DialogTitle>{t('connections.setupTitle', { name: created.name, label: hostLabel(created.host) })}</DialogTitle>
              <DialogDescription>{t('connections.setupDescription')}</DialogDescription>
            </>
          ) : (
            <>
              {!editing && <p className="text-xs text-muted-foreground">{t('connections.stepScope')} · {t('connections.stepNext')}</p>}
              <DialogTitle>{editing ? t('connections.editTitle', { name: editing.name }) : t('connections.createTitle')}</DialogTitle>
              <DialogDescription>{editing ? t('connections.editDescription') : t('connections.createDescription')}</DialogDescription>
            </>
          )}
        </DialogHeader>
        {created ? (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <SetupStep created={created} />
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t glass-divider px-5 py-4">
              <p className="text-xs text-muted-foreground">{t('connections.setupFooter')}</p>
              <Button type="button" onClick={onClose}>{t('connections.done')}</Button>
            </div>
          </>
        ) : (
          <form onSubmit={(event) => { void submit(event); }} noValidate className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
              <HostPicker value={host} locked={Boolean(editing)} onChange={setHost} />
              <label className="block text-sm">
                {t('connections.nameLabel')}
                <Input className="mt-2" aria-label={t('connections.nameAria')} placeholder={t('connections.namePlaceholder')} required value={name} onChange={(event) => setName(event.target.value)} />
              </label>
              <AccessPicker topics={topics} archivedTopics={archivedTopics} missingIds={missingIds} includeInbox={includeInbox} topicIds={topicIds} pinSelected={Boolean(editing)} onChange={(next) => { setIncludeInbox(next.includeInbox); setTopicIds(next.topicIds); }} />
              <AutoActionSwitches value={autoActions} onChange={setAutoActions} />
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t glass-divider px-5 py-4">
              <p aria-live="polite" className={blocked ? 'text-xs text-warning' : 'text-xs text-muted-foreground'}>{hint}</p>
              <div className="flex gap-2">
                <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>{t('connections.cancel')}</Button>
                <Button type="submit" disabled={busy || !ready}>{busy ? t('connections.saving') : editing ? t('connections.saveScope') : t('connections.createAndSetup')}</Button>
              </div>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SetupStep({ created }: { created: CreatedConnection }) {
  const { t } = useTranslation('workspace');
  const [visible, setVisible] = useState(false);
  const label = hostLabel(created.host);
  const [legacyEntry, setLegacyEntry] = useState(false);
  const setup = setupSnippet(created.host, created.configuration, created.token, legacyEntry ? 'work_with_agent' : 'dovun');
  const copyLabel = legacyEntry ? t('connections.copySnippet') : created.host === 'grok' ? t('connections.copyGrok') : created.host === 'claude' ? t('connections.copyClaude') : created.host === 'codex' ? t('connections.copyCodex') : t('connections.copySnippet');
  const confirmCommand = created.host === 'grok' ? 'grok mcp list' : created.host === 'claude' ? `claude mcp get ${legacyEntry ? 'work_with_agent' : 'dovun'}` : '';
  return (
    <div className="space-y-4">
      <div className="flex gap-2 rounded-lg border border-warning-border bg-warning-bg px-3 py-2 text-sm text-warning">
        <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <p>{t('connections.credentialOnce')}</p>
      </div>
      <ol className="list-decimal space-y-4 pl-5 text-sm">
        <li className="space-y-2">
          <p>{legacyEntry ? t('connections.transitionHint') : created.host === 'codex' ? t('connections.powershellCodex') : t('connections.powershellCommand')}</p>
          <p className="text-xs text-muted-foreground">{t('connections.transitionHint')}</p><label className="flex items-center gap-2 text-sm"><Checkbox  checked={legacyEntry} onChange={event => setLegacyEntry(event.target.checked)} />{t('connections.legacyEntry')}</label><pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs">{setup}</pre>
          <CopyButton label={copyLabel} text={setup} />
          <div className="flex flex-wrap items-center gap-2">
            <Input readOnly className="min-w-0 flex-1" type={visible ? 'text' : 'password'} autoComplete="off" spellCheck={false} aria-label={t('connections.credentialAria')} value={created.token} />
            <Button type="button" variant="outline" size="sm" onClick={() => setVisible((value) => !value)}>{visible ? t('connections.hideToken') : t('connections.showToken')}</Button>
            <CopyButton label={t('connections.copyToken')} text={created.token} />
          </div>
        </li>
        <li className="space-y-2">
          {created.host === 'codex' ? <p><Trans t={t} i18nKey="connections.restartCodex" components={{ code: <code /> }} /></p> : confirmCommand ? (
            <>
              <p>{t('connections.confirmSaved')}</p>
              <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs">{confirmCommand}</pre>
              <CopyButton label={t('connections.copySnippet')} text={confirmCommand} />
            </>
          ) : <p>{t('connections.confirmSaved')}</p>}
        </li>
        <li className="space-y-2">
          <p>{t('connections.testSession', { label })}</p>
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg bg-muted p-3 text-xs">{t('connections.samplePrompt')}</pre>
          <CopyButton label={t('connections.copySnippet')} text={t('connections.samplePrompt')} />
        </li>
      </ol>
      <p className="text-xs text-muted-foreground">{t('connections.credentialWarning', { url: created.configuration.env.DOVUN_API_URL })}</p>
      <p className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">{t('connections.waitingStatic')}</p>
    </div>
  );
}

function CopyButton({ label, text }: { label: string; text: string }) {
  const { t } = useTranslation('workspace');
  const [copied, setCopied] = useState(false);
  return (
    <Button type="button" variant="outline" size="sm" onClick={() => { void navigator.clipboard.writeText(text).then(() => setCopied(true)).catch(() => toast.error(t('connections.copyFailed'))); }}>
      {copied ? t('connections.copied') : label}
    </Button>
  );
}
