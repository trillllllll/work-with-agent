import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Check, ChevronDown, Clock, Copy, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, type Topic } from '@/lib/api.js';
import { intlLocale } from '@/i18n/index.js';
import { hostLabel } from '@/lib/connection-status.js';
import { checkSnippet, type ConnectionConfiguration } from '@/lib/connection-snippet.js';
import { cn } from '@/lib/utils.js';
import { Button } from '@/components/ui/button.js';

type CheckResult = {
  healthy: boolean;
  status: string;
  missingTopicIds: string[];
  topics?: { id: string; name: string }[];
  checks?: { credentialActive?: boolean; scopeResolved?: boolean };
};

type ConnectionCheckProps = {
  id: string;
  host: string;
  lastCommandAt?: string | null;
  missingTopicIds: string[];
  topics: Topic[];
  archivedTopics: Topic[];
  onMissing: (ids: string[]) => void;
  onEdit: () => void;
};

function formatStamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(intlLocale());
}

export function ConnectionCheck({ id, host, lastCommandAt, missingTopicIds, topics, archivedTopics, onMissing, onEdit }: ConnectionCheckProps) {
  const { t } = useTranslation('workspace');
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const onMissingRef = useRef(onMissing);
  onMissingRef.current = onMissing;
  const checks = useQuery({ queryKey: ['connection-check', id], queryFn: () => api<CheckResult>(`/api/v1/connections/${id}/check`), enabled: open });
  const config = useQuery({ queryKey: ['connection-config', id], queryFn: () => api<ConnectionConfiguration>(`/api/v1/connections/${id}/config`), enabled: open });
  useEffect(() => {
    if (checks.data) onMissingRef.current(checks.data.missingTopicIds);
  }, [checks.data]);
  const missingIds = checks.data?.missingTopicIds ?? missingTopicIds;
  const credentialOk = checks.data ? Boolean(checks.data.checks?.credentialActive ?? checks.data.status !== 'revoked') : true;
  const names = new Map<string, string>();
  for (const topic of [...topics, ...archivedTopics, ...(checks.data?.topics ?? [])]) names.set(topic.id, topic.name);
  const missingNames = missingIds.map((topicId) => names.get(topicId) ?? t('connections.unnamedMissing')).join(t('listSeparator'));
  const placeholder = t('connections.credentialPlaceholder');
  const snippet = config.data ? checkSnippet(host, config.data, placeholder) : t('connections.readingConfig');
  const hostName = hostLabel(host);
  const queryError = checks.error ?? config.error;
  const copy = () => {
    if (!config.data) return;
    void navigator.clipboard.writeText(snippet).then(() => setCopied(true)).catch(() => toast.error(t('connections.copyFailed')));
  };
  const row = (ok: boolean, waiting: boolean, text: string) => (
    <li className="flex items-start gap-2">
      {ok ? <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" /> : waiting ? <Clock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" /> : <X aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />}
      <span className={cn(!ok && waiting && 'text-muted-foreground')}>{text}</span>
    </li>
  );
  return (
    <div>
      <Button type="button" variant="ghost" size="sm" aria-expanded={open} aria-controls={panelId} onClick={() => { setCopied(false); setOpen((value) => !value); }}>
        <ChevronDown aria-hidden="true" className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
        {t('connections.checkSummary')}
      </Button>
      {open && (
        <div id={panelId} className="mt-3 space-y-3 rounded-xl border border-border bg-muted/30 p-3">
          {queryError && <p role="alert" className="text-sm text-destructive">{queryError instanceof Error ? queryError.message : t('connections.loadFailed')}</p>}
          <ul className="space-y-2 text-sm">
            {row(credentialOk, false, credentialOk ? t('connections.checkCredentialOk') : t('connections.checkCredentialBad'))}
            {row(missingIds.length === 0, false, missingIds.length === 0 ? t('connections.checkScopeOk') : t('connections.checkScopeBad', { count: missingIds.length, names: missingNames }))}
            {row(Boolean(lastCommandAt), !lastCommandAt, lastCommandAt ? t('connections.checkHostOk', { time: formatStamp(lastCommandAt) }) : t('connections.checkHostWait', { host: hostName }))}
          </ul>
          {missingIds.length > 0 && <Button type="button" variant="outline" size="sm" onClick={onEdit}>{t('connections.fixAccess')}</Button>}
          <div>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm font-medium">{t('connections.snippetTitle', { host: hostName })}</p>
              <p className="text-xs text-muted-foreground">{t('connections.snippetHint')}</p>
            </div>
            <div className="relative mt-2">
              <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 pr-24 text-xs">{snippet}</pre>
              <Button type="button" variant="outline" size="sm" className="absolute top-2 right-2" disabled={!config.data} onClick={copy}>
                <Copy aria-hidden="true" />
                {copied ? t('connections.copied') : t('connections.copySnippet')}
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{t('connections.reloadHint')}</p>
        </div>
      )}
    </div>
  );
}
