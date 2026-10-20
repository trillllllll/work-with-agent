import { usePageContext } from '@/lib/assistant-context.js';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api, type Topic } from '@/lib/api.js';
import { json, parseStored, usePlatformAction } from '@/lib/platform.js';
import { intlLocale } from '../../i18n/index.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';

type Connection = { id: string; name: string; host: string; status: string; revision: number; topicIds: string[] | string; includeInbox: boolean; autoActions: string[] | string; createdAt: string; lastUsedAt?: string; lastCommandAt?: string; lastWriteAt?: string };
type ConnectionConfiguration = { command: string; args: string[]; url: string; env: { WWA_API_URL: string; WWA_CONNECTION_TOKEN: string } };
type CreatedConnection = Connection & { token: string; configuration: ConnectionConfiguration };
const operationIds = ['task.create', 'task.content', 'task.schedule', 'task.complete', 'task.result'] as const;
function hostLabel(host: string) {
  if (host === 'grok') return 'Grok';
  if (host === 'codex') return 'Codex';
  return 'Claude Code';
}
export function ConnectionsPage({ topics }: { topics: Topic[] }) {
  const { t } = useTranslation('workspace');
  const list = useQuery({ queryKey: ['connections'], queryFn: () => api<Connection[]>('/api/v1/connections') });
  const { run, busy } = usePlatformAction();
  const [editing, setEditing] = useState<Connection | null>(null);
  usePageContext('connections', { pageState: { selectedId: editing?.id ?? '' } });
  const [name, setName] = useState('');
  const [host, setHost] = useState('codex');
  const [selected, setSelected] = useState<string[]>([]);
  const [includeInbox, setInbox] = useState(false);
  const [autoActions, setAuto] = useState<string[]>([]);
  const [created, setCreated] = useState<CreatedConnection | null>(null);
  const missingName = !name.trim();
  const missingScope = !includeInbox && !selected.length;
  const operationLabels: Record<(typeof operationIds)[number], string> = {
    'task.create': t('connections.operations.create'),
    'task.content': t('connections.operations.content'),
    'task.schedule': t('connections.operations.schedule'),
    'task.complete': t('connections.operations.complete'),
    'task.result': t('connections.operations.result'),
  };
  const scopeNames = (include: boolean, topicIds: string[] | string) => [...(include ? [t('inbox')] : []), ...parseStored<string[]>(topicIds, []).map((id) => topics.find((topic) => topic.id === id)?.name ?? id)].join(t('listSeparator'));
  const create = async () => {
    const result = await run(() => api<CreatedConnection>(editing ? `/api/v1/connections/${editing.id}` : '/api/v1/connections', { method: editing ? 'PATCH' : 'POST', body: json({ name: name.trim(), host, topicIds: selected, includeInbox, autoActions, ...(editing ? { expectedRevision: editing.revision } : {}) }) }));
    if (result) { if (!editing) setCreated(result); setName(''); setEditing(null); }
  };
  return <section className="mx-auto max-w-4xl space-y-6 p-5 sm:p-7">
    <header><h1 className="text-2xl font-semibold">{t('connections.title')}</h1><p className="mt-2 text-sm text-muted-foreground">{t('connections.description')}</p></header>
    <form className="glass-subtle space-y-4 rounded-xl p-4" onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <h2 className="font-semibold">{editing ? t('connections.editTitle', { name: editing.name }) : t('connections.createTitle')}</h2>
      <div className="flex flex-wrap items-end gap-3"><label className="min-w-64 flex-1 text-sm">{t('connections.nameLabel')}<Input aria-label={t('connections.nameAria')} placeholder={t('connections.namePlaceholder')} required value={name} onChange={(event) => setName(event.target.value)} className="mt-2" /></label><label className="text-sm">{t('connections.hostLabel')}<select aria-label={t('connections.hostLabel')} className="glass-control mt-2 block h-9 rounded-lg px-3" value={host} onChange={(event) => setHost(event.target.value)}><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="grok">Grok</option></select></label></div>
      <fieldset><legend className="mb-2 text-sm">{t('connections.scopeLegend')}</legend><div className="flex flex-wrap gap-4"><label className="flex items-center gap-2 text-sm"><input aria-label={t('connections.inboxAccess')} type="checkbox" checked={includeInbox} onChange={(event) => setInbox(event.target.checked)} />{t('inbox')}</label>{topics.map((topic) => <label key={topic.id} className="flex items-center gap-2 text-sm"><input aria-label={t('connections.listAccess', { name: topic.name })} type="checkbox" checked={selected.includes(topic.id)} onChange={(event) => setSelected(event.target.checked ? [...selected, topic.id] : selected.filter((id) => id !== topic.id))} />{topic.name}</label>)}</div></fieldset>
      <details className="disclosure"><summary className="cursor-pointer text-sm">{t('connections.autoSummary')}</summary><p className="my-2 text-xs text-muted-foreground">{t('connections.autoHint')}</p><div className="flex flex-wrap gap-4">{operationIds.map((value) => <label key={value} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={autoActions.includes(value)} onChange={(event) => setAuto(event.target.checked ? [...autoActions, value] : autoActions.filter((action) => action !== value))} />{operationLabels[value]}</label>)}</div></details>
      <div className="flex flex-wrap items-center gap-3"><Button disabled={busy || missingName || missingScope}>{busy ? t('connections.saving') : editing ? t('connections.saveScope') : t('connections.createTitle')}</Button>{editing && <Button type="button" variant="ghost" onClick={() => { setEditing(null); setName(''); }}>{t('connections.cancelEdit')}</Button>}<p aria-live="polite" className="text-xs text-muted-foreground">{missingName ? t('connections.missingName') : missingScope ? t('connections.missingScope') : t('connections.ready')}</p></div>
    </form>
    {created && <ConnectionSetup connection={created} onDone={() => setCreated(null)} />}
    {list.error && <p role="alert">{list.error.message}</p>}
    {(list.data ?? []).map((connection) => <article className="glass-subtle space-y-2 rounded-xl p-4" key={connection.id}><div className="flex items-center justify-between gap-3"><h2 className="font-semibold">{connection.name}</h2><span className="text-xs text-muted-foreground">{connection.host} · {connection.status === 'active' ? t('connections.enabled') : t('connections.revoked')}</span></div><p className="text-sm text-muted-foreground">{scopeNames(connection.includeInbox, connection.topicIds)}</p><p className="text-xs text-muted-foreground">{connection.lastCommandAt ? t('connections.lastCommand', { time: new Date(connection.lastCommandAt).toLocaleString(intlLocale()) }) : t('connections.credentialReady')}</p><ConnectionDetails id={connection.id} host={connection.host} />{connection.status === 'active' && <Button variant="ghost" disabled={busy} onClick={() => { setEditing(connection); setName(connection.name); setHost(connection.host); setSelected(parseStored(connection.topicIds, [])); setInbox(connection.includeInbox); setAuto(parseStored(connection.autoActions, [])); }}>{t('connections.editAccess')}</Button>}{connection.status === 'active' && <Button variant="outline" disabled={busy} onClick={() => void run(() => api(`/api/v1/connections/${connection.id}`, { method: 'DELETE', body: json({ expectedRevision: connection.revision }) }), t('connections.revokedToast'))}>{t('connections.revoke')}</Button>}</article>)}
  </section>;
}

function ConnectionSetup({ connection, onDone }: { connection: CreatedConnection; onDone: () => void }) {
  const { t } = useTranslation('workspace');
  const [copied, setCopied] = useState(false);
  const config = connection.configuration;
  const quotePowerShell = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const quotedArgs = config.args.map(quotePowerShell).join(' ');
  const apiEnv = quotePowerShell(`WWA_API_URL=${config.env.WWA_API_URL}`);
  const tokenEnv = quotePowerShell(`WWA_CONNECTION_TOKEN=${config.env.WWA_CONNECTION_TOKEN}`);
  const claudeCommand = `claude mcp add work_with_agent ${quotePowerShell(config.command)} ${quotedArgs} --scope user --env ${apiEnv} ${tokenEnv}`;
  const grokCommand = `grok mcp add work_with_agent --scope user --transport http ${config.url} --header ${quotePowerShell(`Authorization: Bearer ${config.env.WWA_CONNECTION_TOKEN}`)}`;
  const codexConfig = `[mcp_servers.work_with_agent]\ncommand = ${JSON.stringify(config.command)}\nargs = ${JSON.stringify(config.args)}\n[mcp_servers.work_with_agent.env]\nWWA_API_URL = ${JSON.stringify(config.env.WWA_API_URL)}\nWWA_CONNECTION_TOKEN = ${JSON.stringify(config.env.WWA_CONNECTION_TOKEN)}`;
  const setup = connection.host === 'claude' ? claudeCommand : connection.host === 'grok' ? grokCommand : codexConfig;
  const label = hostLabel(connection.host);
  const copy = async () => {
    await navigator.clipboard.writeText(setup);
    setCopied(true);
  };
  return <section className="glass-subtle space-y-4 rounded-xl border border-primary/30 p-4">
    <div><h2 className="font-semibold">{t('connections.credentialTitle')}</h2><p className="mt-1 text-sm text-muted-foreground">{t('connections.credentialHint', { label })}</p></div>
    <Input readOnly aria-label={t('connections.credentialAria')} value={connection.token} />
    <ol className="list-decimal space-y-4 pl-5 text-sm">
      <li><p className="mb-2">{connection.host === 'codex' ? t('connections.powershellCodex') : t('connections.powershellCommand')}</p><pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs">{setup}</pre><Button className="mt-2" type="button" variant="outline" size="sm" onClick={() => void copy()}>{copied ? t('connections.copied') : connection.host === 'grok' ? t('connections.copyGrok') : connection.host === 'claude' ? t('connections.copyClaude') : t('connections.copyCodex')}</Button></li>
      <li>{connection.host === 'grok' ? <><p>{t('connections.confirmSaved')}</p><pre className="mt-2 rounded-lg bg-muted p-3 text-xs">grok mcp list</pre></> : connection.host === 'claude' ? <><p>{t('connections.confirmSaved')}</p><pre className="mt-2 rounded-lg bg-muted p-3 text-xs">claude mcp get work_with_agent</pre></> : <p><Trans t={t} i18nKey="connections.restartCodex" components={{ code: <code /> }} /></p>}</li>
      <li><p>{t('connections.testSession', { label })}</p><pre className="mt-2 whitespace-pre-wrap rounded-lg bg-muted p-3 text-xs">{t('connections.samplePrompt')}</pre></li>
    </ol>
    <p className="text-xs text-muted-foreground">{t('connections.credentialWarning', { url: config.env.WWA_API_URL })}</p>
    <Button variant="outline" onClick={onDone}>{t('connections.done')}</Button>
  </section>;
}

function ConnectionDetails({ id, host }: { id: string; host: string }) {
  const { t } = useTranslation('workspace');
  const [open, setOpen] = useState(false);
  const checks = useQuery({ queryKey: ['connection-check', id], queryFn: () => api<any>(`/api/v1/connections/${id}/check`), enabled: open });
  const config = useQuery({ queryKey: ['connection-config', id], queryFn: () => api<any>(`/api/v1/connections/${id}/config`), enabled: open });
  const value = config.data;
  const placeholder = t('connections.credentialPlaceholder');
  const snippet = !value ? t('connections.readingConfig') : host === 'codex' ? `[mcp_servers.work_with_agent]\ncommand = ${JSON.stringify(value.command)}\nargs = ${JSON.stringify(value.args)}\n[mcp_servers.work_with_agent.env]\nWWA_API_URL = ${JSON.stringify(value.env.WWA_API_URL)}\nWWA_CONNECTION_TOKEN = "${placeholder}"` : host === 'grok' ? `[mcp_servers.work_with_agent]\nurl = ${JSON.stringify(value.url)}\nheaders = { Authorization = "Bearer ${placeholder}" }` : JSON.stringify({ mcpServers: { work_with_agent: { command: value.command, args: value.args, env: value.env } } }, null, 2);
  return <details className="disclosure" onToggle={(event) => setOpen(event.currentTarget.open)}><summary className="cursor-pointer text-xs text-muted-foreground">{t('connections.checkSummary')}</summary><div className="mt-3 space-y-3">{(checks.error || config.error) && <p role="alert">{(checks.error ?? config.error)?.message}</p>}{checks.data && <p className="text-sm">{checks.data.healthy ? t('connections.healthy') : t('connections.unhealthy')}{t('connections.hostCheck', { host: hostLabel(host) })}</p>}<pre className="overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs">{snippet}</pre><p className="text-xs text-muted-foreground">{t('connections.reloadHint')}</p></div></details>;
}
