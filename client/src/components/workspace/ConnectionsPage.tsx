import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type Topic } from '@/lib/api.js';
import { json, parseStored, usePlatformAction } from '@/lib/platform.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';

type Connection = { id: string; name: string; host: string; status: string; revision: number; topicIds: string[] | string; includeInbox: boolean; autoActions: string[] | string; createdAt: string; lastUsedAt?: string; lastCommandAt?: string; lastWriteAt?: string };
type ConnectionConfiguration = { command: string; args: string[]; env: { WWA_API_URL: string; WWA_CONNECTION_TOKEN: string } };
type CreatedConnection = Connection & { token: string; configuration: ConnectionConfiguration };
const operations = [['task.create', '创建任务'], ['task.content', '编辑标题与说明'], ['task.schedule', '修改日期与优先级'], ['task.complete', '完成与重开'], ['task.result', '写回结果']] as const;
export function ConnectionsPage({ topics }: { topics: Topic[] }) {
  const list = useQuery({ queryKey: ['connections'], queryFn: () => api<Connection[]>('/api/v1/connections') });
  const { run, busy } = usePlatformAction();
  const [editing, setEditing] = useState<Connection | null>(null);
  const [name, setName] = useState('');
  const [host, setHost] = useState('codex');
  const [selected, setSelected] = useState<string[]>([]);
  const [includeInbox, setInbox] = useState(false);
  const [autoActions, setAuto] = useState<string[]>([]);
  const [created, setCreated] = useState<CreatedConnection | null>(null);
  const missingName = !name.trim();
  const missingScope = !includeInbox && !selected.length;
  const create = async () => {
    const result = await run(() => api<CreatedConnection>(editing ? `/api/v1/connections/${editing.id}` : '/api/v1/connections', { method: editing ? 'PATCH' : 'POST', body: json({ name: name.trim(), host, topicIds: selected, includeInbox, autoActions, ...(editing ? { expectedRevision: editing.revision } : {}) }) }));
    if (result) { if (!editing) setCreated(result); setName(''); setEditing(null); }
  };
  return <section className="mx-auto max-w-4xl space-y-6 p-5 sm:p-7">
    <header><h1 className="text-2xl font-semibold">AI 连接</h1><p className="mt-2 text-sm text-muted-foreground">让 Codex 和 Claude Code 访问选定清单。每个连接拥有独立凭据，默认修改需要确认。</p></header>
    <form className="glass-subtle space-y-4 rounded-xl p-4" onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <h2 className="font-semibold">{editing ? `修改连接：${editing.name}` : '创建连接'}</h2>
      <div className="flex flex-wrap items-end gap-3"><label className="min-w-64 flex-1 text-sm">连接名称（必填）<Input aria-label="连接名称" placeholder="例如：我的 Claude Code" required value={name} onChange={(event) => setName(event.target.value)} className="mt-2" /></label><label className="text-sm">AI 宿主<select aria-label="AI 宿主" className="glass-control mt-2 block h-9 rounded-lg px-3" value={host} onChange={(event) => setHost(event.target.value)}><option value="codex">Codex</option><option value="claude">Claude Code</option></select></label></div>
      <fieldset><legend className="mb-2 text-sm">允许访问（至少选择一项）</legend><div className="flex flex-wrap gap-4"><label className="flex items-center gap-2 text-sm"><input aria-label="允许访问收集箱" type="checkbox" checked={includeInbox} onChange={(event) => setInbox(event.target.checked)} />收集箱</label>{topics.map((topic) => <label key={topic.id} className="flex items-center gap-2 text-sm"><input aria-label={`允许访问清单：${topic.name}`} type="checkbox" checked={selected.includes(topic.id)} onChange={(event) => setSelected(event.target.checked ? [...selected, topic.id] : selected.filter((id) => id !== topic.id))} />{topic.name}</label>)}</div></fieldset>
      <details><summary className="cursor-pointer text-sm">允许直接执行的操作（可选）</summary><p className="my-2 text-xs text-muted-foreground">未勾选的修改进入待确认。移动、父子关系、删除与恢复继续确认。</p><div className="flex flex-wrap gap-4">{operations.map(([value, label]) => <label key={value} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={autoActions.includes(value)} onChange={(event) => setAuto(event.target.checked ? [...autoActions, value] : autoActions.filter((action) => action !== value))} />{label}</label>)}</div></details>
      <div className="flex flex-wrap items-center gap-3"><Button disabled={busy || missingName || missingScope}>{busy ? '正在保存…' : editing ? '保存授权范围' : '创建连接'}</Button>{editing && <Button type="button" variant="ghost" onClick={() => { setEditing(null); setName(''); }}>取消编辑</Button>}<p aria-live="polite" className="text-xs text-muted-foreground">{missingName ? '请先填写连接名称。' : missingScope ? '请至少选择收集箱或一个清单。' : '连接信息已完整，可以创建。'}</p></div>
    </form>
    {created && <ConnectionSetup connection={created} onDone={() => setCreated(null)} />}
    {list.error && <p role="alert">{list.error.message}</p>}
    {(list.data ?? []).map((connection) => <article className="glass-subtle space-y-2 rounded-xl p-4" key={connection.id}><div className="flex items-center justify-between gap-3"><h2 className="font-semibold">{connection.name}</h2><span className="text-xs text-muted-foreground">{connection.host} · {connection.status === 'active' ? '已启用' : '已撤销'}</span></div><p className="text-sm text-muted-foreground">{[...(connection.includeInbox ? ['收集箱'] : []), ...parseStored<string[]>(connection.topicIds, []).map((id) => topics.find((topic) => topic.id === id)?.name ?? id)].join('、')}</p><p className="text-xs text-muted-foreground">{connection.lastCommandAt ? `最近命令：${new Date(connection.lastCommandAt).toLocaleString()}` : '连接凭据已建立；宿主连接后可自检。'}</p><ConnectionDetails id={connection.id} host={connection.host} />{connection.status === 'active' && <Button variant="ghost" disabled={busy} onClick={() => { setEditing(connection); setName(connection.name); setHost(connection.host); setSelected(parseStored(connection.topicIds, [])); setInbox(connection.includeInbox); setAuto(parseStored(connection.autoActions, [])); }}>修改授权</Button>}{connection.status === 'active' && <Button variant="outline" disabled={busy} onClick={() => void run(() => api(`/api/v1/connections/${connection.id}`, { method: 'DELETE', body: json({ expectedRevision: connection.revision }) }), '连接已撤销')}>撤销连接</Button>}</article>)}
  </section>;
}

function ConnectionSetup({ connection, onDone }: { connection: CreatedConnection; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const config = connection.configuration;
  const quotePowerShell = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const claudeCommand = `claude mcp add work_with_agent ${quotePowerShell(config.command)} ${config.args.map(quotePowerShell).join(' ')} --scope user --env ${quotePowerShell(`WWA_API_URL=${config.env.WWA_API_URL}`)} ${quotePowerShell(`WWA_CONNECTION_TOKEN=${config.env.WWA_CONNECTION_TOKEN}`)}`;
  const codexConfig = `[mcp_servers.work_with_agent]\ncommand = ${JSON.stringify(config.command)}\nargs = ${JSON.stringify(config.args)}\n[mcp_servers.work_with_agent.env]\nWWA_API_URL = ${JSON.stringify(config.env.WWA_API_URL)}\nWWA_CONNECTION_TOKEN = ${JSON.stringify(config.env.WWA_CONNECTION_TOKEN)}`;
  const setup = connection.host === 'claude' ? claudeCommand : codexConfig;
  const copy = async () => {
    await navigator.clipboard.writeText(setup);
    setCopied(true);
  };
  return <section className="glass-subtle space-y-4 rounded-xl border border-primary/30 p-4">
    <div><h2 className="font-semibold">连接凭据</h2><p className="mt-1 text-sm text-muted-foreground">这是 {connection.host === 'claude' ? 'Claude Code' : 'Codex'} 访问本应用的钥匙，只在本次创建后显示。</p></div>
    <Input readOnly aria-label="连接凭据" value={connection.token} />
    <ol className="list-decimal space-y-4 pl-5 text-sm">
      <li><p className="mb-2">确认本应用服务保持运行，然后在 PowerShell {connection.host === 'claude' ? '执行下面这条命令' : '将下面内容加入 Codex 的 config.toml'}：</p><pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs">{setup}</pre><Button className="mt-2" type="button" variant="outline" size="sm" onClick={() => void copy()}>{copied ? '已复制' : `复制 ${connection.host === 'claude' ? 'Claude Code 配置命令' : 'Codex 配置'}`}</Button></li>
      <li>{connection.host === 'claude' ? <><p>运行以下命令确认配置已保存：</p><pre className="mt-2 rounded-lg bg-muted p-3 text-xs">claude mcp get work_with_agent</pre></> : <p>重新启动 Codex，并在 MCP 面板确认 <code>work_with_agent</code> 已启用。</p>}</li>
      <li><p>在新的 {connection.host === 'claude' ? 'Claude Code' : 'Codex'} 会话中测试：</p><pre className="mt-2 whitespace-pre-wrap rounded-lg bg-muted p-3 text-xs">请使用 work_with_agent 的 list_tasks 列出我的收集箱任务。</pre></li>
    </ol>
    <p className="text-xs text-muted-foreground">凭据会保存在本机宿主配置中，请勿提交到 Git 或发送给他人。宿主读取的是本机 API {config.env.WWA_API_URL}。</p>
    <Button variant="outline" onClick={onDone}>我已完成配置</Button>
  </section>;
}

function ConnectionDetails({ id, host }: { id: string; host: string }) {
  const [open, setOpen] = useState(false);
  const checks = useQuery({ queryKey: ['connection-check', id], queryFn: () => api<any>(`/api/v1/connections/${id}/check`), enabled: open });
  const config = useQuery({ queryKey: ['connection-config', id], queryFn: () => api<any>(`/api/v1/connections/${id}/config`), enabled: open });
  const value = config.data;
  const snippet = !value ? '正在读取配置…' : host === 'codex' ? `[mcp_servers.work_with_agent]\ncommand = ${JSON.stringify(value.command)}\nargs = ${JSON.stringify(value.args)}\n[mcp_servers.work_with_agent.env]\nWWA_API_URL = ${JSON.stringify(value.env.WWA_API_URL)}\nWWA_CONNECTION_TOKEN = "填入创建时保存的凭据"` : JSON.stringify({ mcpServers: { work_with_agent: { command: value.command, args: value.args, env: value.env } } }, null, 2);
  return <details onToggle={(event) => setOpen(event.currentTarget.open)}><summary className="cursor-pointer text-xs text-muted-foreground">授权自检与宿主配置</summary><div className="mt-3 space-y-3">{(checks.error || config.error) && <p role="alert">{(checks.error ?? config.error)?.message}</p>}{checks.data && <p className="text-sm">{checks.data.healthy ? '凭据已启用，授权范围有效。' : '凭据已撤销或部分授权清单不可用。'}宿主连接状态请在 {host === 'codex' ? 'Codex' : 'Claude Code'} 的 MCP 面板查看，并调用 list_tasks 验证。</p>}<pre className="overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs">{snippet}</pre><p className="text-xs text-muted-foreground">修改宿主配置后重新加载 MCP。撤销连接后，旧凭据无法访问本机服务。</p></div></details>;
}
