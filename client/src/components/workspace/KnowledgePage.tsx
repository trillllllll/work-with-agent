import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, type Topic } from '@/lib/api.js';
import { organizationMcpPrompt } from '@/lib/organization-prompt.js';
import { json, submitCommands, usePlatformAction } from '@/lib/platform.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Textarea } from '@/components/ui/textarea.js';
import { ContextPicker, type Evidence } from './ContextPicker.js';

type PageResult<T> = { items: T[]; total: number; nextCursor: number | null };
type Resource = { id: string; title: string; kind: string; revision: number; content?: string; uri?: string; health?: string; status?: string; evidence?: any[]; archivedAt?: string | null; versions?: any[] };
type ResourceEditing = { id: string; scope: string; resource?: Resource };
type BriefDraft = { notes: string; revision: number };
const memoryKinds = { fact: '事实', decision: '决策', constraint: '约束', learning: '经验', question: '未决问题' };
export function KnowledgePage({ topics, initialTopicId = '', taskId }: { topics: Topic[]; initialTopicId?: string; taskId?: string }) {
  const [topicId, setTopic] = useState(initialTopicId);
  const [tab, setTab] = useState<'materials' | 'memories' | 'brief' | 'search'>('materials');
  const [cursor, setCursor] = useState(0);
  const [search, setSearch] = useState('');
  const [history, setHistory] = useState(false);
  const [editing, setEditing] = useState<ResourceEditing | null>(null);
  const [briefDrafts, setBriefDrafts] = useState<Record<string, BriefDraft | null>>({});
  const [opened, setOpened] = useState<string>('');
  const scope = `topicId=${encodeURIComponent(topicId || 'inbox')}`;
  const editorScope = `${topicId}:${tab}`;
  const activeEditor = editing?.scope === editorScope ? editing : null;
  const openEditor = (resource?: Resource) => setEditing({ id: crypto.randomUUID(), scope: editorScope, resource });
  const updateBriefDraft = (update: (current: BriefDraft | null) => BriefDraft | null) => setBriefDrafts((drafts) => ({ ...drafts, [topicId]: update(drafts[topicId] ?? null) }));
  useEffect(() => { setCursor(0); setOpened(''); }, [topicId, tab]);
  const list = useQuery({ queryKey: ['knowledge', tab, topicId, taskId, cursor, history], queryFn: () => api<PageResult<Resource>>(`/api/v1/knowledge/${tab}?${scope}&cursor=${cursor}&history=${history}&includeArchived=${history}${taskId && tab === 'materials' ? `&taskId=${taskId}` : ''}`), enabled: tab === 'materials' || tab === 'memories' });
  const detail = useQuery({ queryKey: ['knowledge', tab, opened], queryFn: () => api<Resource>(`/api/v1/knowledge/${tab}/${opened}`), enabled: Boolean(opened) && (tab === 'materials' || tab === 'memories') });
  const hits = useQuery({ queryKey: ['knowledge-search', topicId, search, history, cursor], queryFn: () => api<PageResult<any>>(`/api/v1/knowledge/search?${scope}&q=${encodeURIComponent(search)}&includeHistory=${history}&cursor=${cursor}&limit=40`), enabled: tab === 'search' && Boolean(search.trim()) });
  const { run, busy } = usePlatformAction();
  const resource = detail.data;
  return <section className={taskId ? 'space-y-4' : 'mx-auto max-w-5xl space-y-5 p-5 sm:p-7'}>
    {!taskId && <header className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-2xl font-semibold">项目资料</h1><p className="mt-2 text-sm text-muted-foreground">保存原始依据，维护长期记忆，随时回到当前进展。</p></div><select aria-label="资料所属清单" className="glass-control h-10 rounded-lg px-3 text-sm" value={topicId} onChange={(event) => setTopic(event.target.value)}><option value="">收集箱</option>{topics.map((topic) => <option key={topic.id} value={topic.id}>{topic.name}</option>)}</select></header>}
    <a className="inline-block text-xs text-primary underline" href={`/api/v1/knowledge/export?${scope}`}>导出本范围的资料、记忆及修订历史</a>
    <nav className="flex flex-wrap gap-2" aria-label="项目资料分类">{[['materials', '材料'], ['memories', '记忆'], ['brief', '当前简报'], ['search', '查找依据']].map(([value, label]) => <Button key={value} size="sm" variant={tab === value ? 'secondary' : 'ghost'} onClick={() => setTab(value as typeof tab)}>{label}</Button>)}</nav>
    {tab === 'brief' ? <BriefPanel key={topicId} topicId={topicId || null} draft={briefDrafts[topicId] ?? null} updateDraft={updateBriefDraft} /> : <>
      <div className="flex flex-wrap items-center gap-3">{tab === 'search' ? <Input aria-label="查找资料与记忆" placeholder="查找任务、材料与记忆" value={search} onChange={(event) => { setSearch(event.target.value); setCursor(0); }} className="max-w-md" /> : <Button size="sm" onClick={() => openEditor()}>{tab === 'materials' ? '保存材料' : '记录记忆'}</Button>}<label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={history} onChange={(event) => { setHistory(event.target.checked); setCursor(0); }} />包含历史与归档</label></div>
      {activeEditor && tab !== 'search' && <ResourceEditor key={activeEditor.id} type={tab} resource={activeEditor.resource} topicId={topicId || null} taskId={taskId} onClose={() => setEditing((current) => current?.id === activeEditor.id ? null : current)} />}
      {(list.error || hits.error) && <p role="alert" className="text-sm text-destructive">{(list.error ?? hits.error)?.message}</p>}
      {tab === 'search' ? <div className="space-y-3">{hits.data?.items.map((hit) => <article key={`${hit.type}:${hit.id}:${hit.revision}`} className="glass-subtle rounded-xl p-4"><h2 className="font-semibold">{hit.title}</h2><p className="mt-2 whitespace-pre-wrap text-sm">{hit.snippet}</p><p className="mt-2 text-xs text-muted-foreground">{hit.type === 'material' ? '材料' : hit.type === 'memory' ? '记忆' : '任务'} · 版本 {hit.revision} · {hit.status}</p></article>)}</div> : <div className="space-y-3">{!list.isLoading && !list.data?.items.length && <p className="py-6 text-sm text-muted-foreground">暂无{tab === 'materials' ? '材料' : '记忆'}，可以先手动保存。</p>}{list.data?.items.map((item) => <article key={item.id} className="glass-subtle space-y-3 rounded-xl p-4"><button type="button" className="flex w-full flex-wrap items-center justify-between gap-2 text-left" onClick={() => setOpened(opened === item.id ? '' : item.id)}><strong className="text-sm">{item.title}</strong><span className="text-xs text-muted-foreground">版本 {item.revision}{item.health && item.health !== 'current' ? ' · 来源待复核' : ''}{item.archivedAt ? ' · 已归档' : ''}{item.status && item.status !== 'active' ? ' · 已保留为历史' : ''}</span></button>{opened === item.id && resource?.id === item.id && <><p className="whitespace-pre-wrap break-words text-sm">{tab === 'materials' ? resource.versions?.[0]?.content : resource.content}</p>{resource.uri && <a className="break-all text-sm text-primary underline" href={resource.uri} target="_blank" rel="noreferrer">查看来源链接</a>}{resource.versions?.[0]?.hasAttachment && <a className="text-sm text-primary underline" href={`/api/v1/knowledge/materials/${resource.id}/versions/${resource.revision}/attachment`}>下载附件</a>}<div className="flex flex-wrap gap-2">{resource.kind === 'link' && <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => api(`/api/v1/knowledge/materials/${resource.id}/fetch`, { method: 'POST', body: json({ expectedVersion: resource.revision }) }), '网页快照已保存')}>抓取链接正文快照</Button>}<Button size="sm" variant="outline" onClick={() => openEditor(resource)}>编辑{tab === 'materials' ? '材料' : '记忆'}</Button>{tab === 'materials' ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => submitCommands([{ kind: 'material.archive', targetId: item.id, expectedRevision: item.revision, input: { archived: !item.archivedAt } }]), item.archivedAt ? '材料已恢复' : '材料已归档')}>{item.archivedAt ? '恢复材料' : '归档材料'}</Button> : item.status === 'active' && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => submitCommands([{ kind: 'memory.retire', targetId: item.id, expectedRevision: item.revision, input: { reason: '用户将该记忆设为历史' } }]), '记忆已保留为历史')}>设为历史</Button>}</div><details><summary className="cursor-pointer text-xs text-muted-foreground">来源与修订历史</summary>{resource.evidence?.map((ref) => <p key={`${ref.type}:${ref.id}`} className="my-2 break-all text-xs">{ref.type} · {ref.id} · 版本 {ref.revision}</p>)}{resource.versions?.map((version) => <div key={version.revision} className="mt-3 border-t pt-2 text-xs"><p>版本 {version.revision} · {version.reason ?? '保存原文'}</p><p className="mt-1 whitespace-pre-wrap">{version.content}</p></div>)}</details></>}</article>)}</div>}
      <div className="flex gap-2"><Button variant="ghost" size="sm" disabled={!cursor} onClick={() => setCursor(Math.max(0, cursor - 40))}>上一页</Button><Button variant="ghost" size="sm" disabled={(tab === 'search' ? hits.data : list.data)?.nextCursor == null} onClick={() => setCursor((tab === 'search' ? hits.data : list.data)?.nextCursor ?? 0)}>下一页</Button></div>
    </>}
    {!taskId && <OrganizationPanel topicId={topicId || null} />}
  </section>;
}
function ResourceEditor({ type, resource, topicId, taskId, onClose }: { type: 'materials' | 'memories'; resource?: Resource; topicId: string | null; taskId?: string; onClose: () => void }) {
  const isMaterial = type === 'materials';
  const [title, setTitle] = useState(resource?.title ?? '');
  const [content, setContent] = useState(isMaterial ? resource?.versions?.[0]?.content ?? '' : resource?.content ?? '');
  const [kind, setKind] = useState(resource?.kind ?? (isMaterial ? 'text' : 'fact'));
  const [uri, setUri] = useState(resource?.uri ?? '');
  const [completeness, setCompleteness] = useState(resource?.versions?.[0]?.metadata?.completeness ?? 'excerpt');
  const [attachment, setAttachment] = useState<{ attachmentBase64: string; fileName: string; mimeType: string } | null>(null);
  const [evidence, setEvidence] = useState<Evidence[]>(resource?.evidence ?? []);
  const [reason, setReason] = useState('');
  const [sessionId, setSessionId] = useState(resource?.versions?.[0]?.metadata?.sessionId ?? '');
  const [provider, setProvider] = useState(resource?.versions?.[0]?.metadata?.provider ?? 'manual');
  const [fileError, setFileError] = useState('');
  const { run, busy } = usePlatformAction();
  async function selectFile(file?: File) {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { setFileError('附件不得超过 8 MiB'); return; }
    setFileError('');
    const reader = new FileReader();
    reader.onload = () => setAttachment({ attachmentBase64: String(reader.result).split(',')[1], fileName: file.name, mimeType: file.type || 'application/octet-stream' });
    reader.onerror = () => setFileError('读取附件失败，请重新选择。');
    reader.readAsDataURL(file);
  }
  return <form className="glass-subtle space-y-3 rounded-xl border border-primary/30 p-4" onSubmit={(event) => { event.preventDefault(); void run(async () => {
    const input: Record<string, unknown> = { title, content, ...(!resource ? { topicId, kind, ...(isMaterial && taskId ? { taskId } : {}) } : {}) };
    if (isMaterial) { if (kind === 'link') input.uri = uri; if (kind === 'thread') input.metadata = { completeness, sessionId: sessionId || undefined, provider }; if (attachment) Object.assign(input, attachment); }
    else { input.kind = kind; input.evidence = evidence; input.reason = reason || (resource ? '用户修订' : '人工记录'); }
    const result = await submitCommands([{ kind: `${isMaterial ? 'material' : 'memory'}.${resource ? 'update' : 'create'}`, ...(resource ? { targetId: resource.id, expectedRevision: resource.revision } : {}), input }]);
    onClose(); return result;
  }); }}>
    <fieldset className="space-y-3" disabled={busy}>
    <h2 className="font-semibold">{resource ? '编辑' : '新增'}{isMaterial ? '材料' : '记忆'}</h2>
    <Input aria-label={isMaterial ? '材料标题' : '记忆标题'} placeholder="标题" value={title} onChange={(event) => setTitle(event.target.value)} required />
    <select aria-label={isMaterial ? '材料类型' : '记忆类型'} className="glass-control h-9 rounded-lg px-3 text-sm" disabled={Boolean(resource && isMaterial)} value={kind} onChange={(event) => setKind(event.target.value)}>{Object.entries(isMaterial ? { text: '文本', markdown: 'Markdown', link: '链接', thread: '保存会话', attachment: '附件' } : memoryKinds).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select>
    {kind === 'link' && <Input type="url" aria-label="来源链接" placeholder="https://…" value={uri} onChange={(event) => setUri(event.target.value)} required />}
    {kind === 'thread' && <select aria-label="会话保存范围" className="glass-control h-9 rounded-lg px-3 text-sm" value={completeness} onChange={(event) => setCompleteness(event.target.value)}><option value="excerpt">会话片段</option><option value="full">完整会话</option><option value="summary">接力摘要</option></select>}
    {kind === 'attachment' ? <><input aria-label="选择附件" type="file" onChange={(event) => void selectFile(event.target.files?.[0])} />{fileError && <p role="alert">{fileError}</p>}</> : <Textarea aria-label={isMaterial ? '材料正文' : '记忆正文'} placeholder={isMaterial ? '原始内容或链接说明' : '事实、决策及其理由'} value={content} onChange={(event) => setContent(event.target.value)} rows={5} />}
    {!isMaterial && <><ContextPicker topicId={topicId} selected={evidence} onChange={setEvidence} /><Input aria-label="记忆修订理由" placeholder="记录或替代这条记忆的理由" value={reason} onChange={(event) => setReason(event.target.value)} /></>}
    {kind === 'thread' && <div className="flex flex-wrap gap-2"><Input aria-label="会话宿主" placeholder="宿主，例如 Codex" value={provider} onChange={(event) => setProvider(event.target.value)} /><Input aria-label="外部会话标识" placeholder="会话标识（可选）" value={sessionId} onChange={(event) => setSessionId(event.target.value)} /></div>}
    <div className="flex justify-end gap-2"><Button type="button" variant="ghost" disabled={busy} onClick={onClose}>取消</Button><Button disabled={busy || !title.trim() || (!isMaterial && !content.trim())}>保存{isMaterial ? '材料' : '记忆'}</Button></div>
    </fieldset>
  </form>;
}
function BriefPanel({ topicId, draft, updateDraft }: { topicId: string | null; draft: BriefDraft | null; updateDraft: (update: (current: BriefDraft | null) => BriefDraft | null) => void }) {
  const query = useQuery({ queryKey: ['brief', topicId], queryFn: () => api<any>(`/api/v1/knowledge/brief?topicId=${topicId ?? 'inbox'}`) });
  const { run, busy } = usePlatformAction();
  async function save() {
    if (!draft) return;
    const submitted = draft;
    await run(async () => {
      const result = await api<{ revision: number }>('/api/v1/knowledge/brief', { method: 'PUT', body: json({ topicId, expectedVersion: submitted.revision, manualNotes: submitted.notes }) });
      // This updater belongs to the submitted scope. New typing remains a draft
      // based on the saved revision; a late response cannot clear another scope.
      updateDraft((current) => current === submitted ? null : current?.revision === submitted.revision ? { ...current, revision: result.revision } : current);
      return result;
    });
  }
  return <div className="space-y-4">{query.error && <p role="alert">{query.error.message}</p>}<pre className="glass-subtle whitespace-pre-wrap rounded-xl p-4 text-sm leading-relaxed">{query.data?.content ?? '正在准备当前简报…'}</pre><label className="block text-sm">固定说明<Textarea className="mt-2" aria-label="简报固定说明" disabled={!query.data} value={draft?.notes ?? query.data?.manualNotes ?? ''} onChange={(event) => { const notes = event.target.value; updateDraft((current) => ({ notes, revision: current?.revision ?? query.data.revision })); }} /></label><Button disabled={busy || draft === null} onClick={() => void save()}>保存固定说明</Button></div>;
}
function OrganizationPrompt({ id, purpose }: { id: string; purpose: string }) {
  const [copied, setCopied] = useState(false);
  const prompt = organizationMcpPrompt({ id, purpose });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
    } catch {
      toast.error('复制失败，请手动选择提示词');
    }
  };
  return <div className="space-y-2"><p className="text-xs text-muted-foreground">复制下面的提示词，粘贴到已连接 work_with_agent 的 AI 会话。</p><pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-3 text-xs" aria-label={`整理提示词 ${id}`}>{prompt}</pre><Button type="button" variant="outline" size="sm" aria-label={`复制整理提示词 ${id}`} onClick={() => void copy()}>{copied ? '已复制' : '复制提示词'}</Button></div>;
}
function OrganizationPanel({ topicId }: { topicId: string | null }) {
  const query = useQuery({ queryKey: ['organizations', topicId], queryFn: () => api<any[]>(`/api/v1/knowledge/organizations?topicId=${topicId ?? 'inbox'}`) });
  const [purpose, setPurpose] = useState('整理资料中的下一步任务、决策和需要确认的问题');
  const [provider, setProvider] = useState('external');
  const { run, busy } = usePlatformAction();
  return <details className="glass-subtle rounded-xl p-4"><summary className="cursor-pointer text-sm font-semibold">AI 辅助整理</summary><div className="mt-4 space-y-3"><Textarea aria-label="整理目标" value={purpose} onChange={(event) => setPurpose(event.target.value)} /><select aria-label="整理方式" className="glass-control h-9 rounded-lg px-3 text-sm" value={provider} onChange={(event) => setProvider(event.target.value)}><option value="external">外部 AI 通过 MCP 整理</option><option value="builtin">使用已配置的内置模型</option></select><Button size="sm" disabled={busy || !purpose.trim()} onClick={() => void run(async () => { const request = await api<any>('/api/v1/knowledge/organizations', { method: 'POST', body: json({ topicId, purpose, provider }) }); return provider === 'builtin' ? api(`/api/v1/knowledge/organizations/${request.id}/generate`, { method: 'POST', body: '{}' }) : request; }, provider === 'builtin' ? '整理建议已生成' : '整理请求已准备')}>准备整理</Button>{query.data?.map((request) => <article className="space-y-2 border-t pt-3" key={request.id}><p className="text-sm">{request.purpose}</p><p className="text-xs text-muted-foreground">{request.status} · {new Date(request.createdAt).toLocaleString()}</p>{request.error && <p role="alert" className="text-xs text-destructive">{request.error}</p>}{request.result?.summary && <p className="whitespace-pre-wrap text-sm">{request.result.summary}</p>}{request.provider === 'external' && !['proposed', 'completed'].includes(request.status) && <OrganizationPrompt id={request.id} purpose={request.purpose} />}{request.proposalIds?.length > 0 && <a className="text-sm text-primary underline" href="#/proposals">检查待确认建议</a>}</article>)}</div></details>;
}
