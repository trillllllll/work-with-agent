import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api, type Task } from '@/lib/api.js';
import { json, parseStored, usePlatformAction } from '@/lib/platform.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Textarea } from '@/components/ui/textarea.js';
import { ContextPicker, type Evidence } from './ContextPicker.js';

const stateNames: Record<string, string> = { prepared: '待接手', created: '已创建', accepted: '已领取', running: '执行中', returned: '已返回，待验收', failed: '执行失败', cancelled: '已取消', unknown: '状态待核实', accepted_result: '已采纳', reviewed: '已验收', needs_input: '需要补充信息', waiting_input: '需要补充信息', rejected: '需要返工' };
export function HandoffPanel({ task, disabled = false }: { task: Task; disabled?: boolean }) {
  const list = useQuery({ queryKey: ['handoffs', task.id], queryFn: () => api<any[]>(`/api/v1/handoffs?taskId=${encodeURIComponent(task.id)}`) });
  const [provider, setProvider] = useState('codex');
  const [mode, setMode] = useState('manual');
  const [instruction, setInstruction] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [sources, setSources] = useState<Evidence[]>([]);
  const [write, setWrite] = useState(false);
  const [allowShell, setShell] = useState(false);
  const { run, busy } = usePlatformAction();
  return <section className="space-y-3"><h2 className="text-sm font-semibold">AI 交接</h2><p className="text-xs text-muted-foreground">冻结当前任务和选定上下文，结果返回后由你验收。</p>{disabled && <p className="text-xs text-muted-foreground">请先保存任务编辑，再准备交接。</p>}
    <fieldset className="space-y-3" disabled={disabled || busy}>
      <div className="flex flex-wrap gap-2"><select className="glass-control h-9 rounded-lg px-3 text-sm" aria-label="交接宿主" value={provider} onChange={(event) => setProvider(event.target.value)}><option value="codex">Codex</option><option value="claude">Claude Code</option></select><select className="glass-control h-9 rounded-lg px-3 text-sm" aria-label="交接方式" value={mode} onChange={(event) => setMode(event.target.value)}><option value="manual">已有会话通过 MCP 接手</option><option value="local">本机一键启动</option></select></div>
      <Textarea aria-label="交接目标与约束" placeholder="希望 AI 完成什么？有哪些约束？" value={instruction} onChange={(event) => setInstruction(event.target.value)} />
      <Input aria-label="交接验收标准" placeholder="验收标准与期望产物" value={acceptance} onChange={(event) => setAcceptance(event.target.value)} />
      <ContextPicker topicId={task.topicId ?? null} selected={sources} onChange={setSources} memories />
      {mode === 'local' && <div className="space-y-2 text-sm"><label className="flex items-center gap-2"><input type="checkbox" checked={write} onChange={(event) => setWrite(event.target.checked)} />允许在独立副本中修改文件</label><label className="flex items-center gap-2"><input type="checkbox" checked={allowShell} onChange={(event) => setShell(event.target.checked)} />允许执行项目命令（如运行测试）</label></div>}
      <Button size="sm" disabled={!instruction.trim()} onClick={() => void run(async () => { const result = await api('/api/v1/handoffs', { method: 'POST', body: json({ taskId: task.id, expectedTaskRevision: task.revision, instruction: `${instruction}${acceptance ? `\n\n验收标准与产物：\n${acceptance}` : ''}`, provider, mode, materialIds: sources.filter((ref) => ref.type === 'material').map((ref) => ref.id), memoryIds: sources.filter((ref) => ref.type === 'memory').map((ref) => ref.id), permissions: { profile: write ? 'workspace_write' : 'read_only', allowShell } }) }); setInstruction(''); setAcceptance(''); return result; }, '交接内容已冻结')}>准备交接</Button>
    </fieldset>
    {list.error && <p role="alert" className="text-sm text-destructive">{list.error.message}</p>}
    {(list.data ?? []).map((handoff) => <HandoffCard key={handoff.id} handoff={handoff} task={task} />)}
  </section>;
}
export function RunsPage() {
  const list = useQuery({ queryKey: ['handoffs'], queryFn: () => api<any[]>('/api/v1/handoffs'), refetchInterval: 5000 });
  return <section className="mx-auto max-w-5xl space-y-5 p-5 sm:p-7"><h1 className="text-2xl font-semibold">AI 执行</h1><p className="text-sm text-muted-foreground">在任务详情中准备交接，在这里跟踪执行、收回产物并验收。</p>{list.error && <p role="alert">{list.error.message}</p>}{list.isLoading ? <p>正在加载…</p> : !list.data?.length ? <p className="py-8 text-sm text-muted-foreground">还没有交接记录。</p> : list.data.map((handoff) => <HandoffCard key={handoff.id} handoff={handoff} />)}</section>;
}
function HandoffCard({ handoff: initial, task }: { handoff: any; task?: Task }) {
  const [open, setOpen] = useState(false);
  const detail = useQuery({ queryKey: ['handoff', initial.id], queryFn: () => api<any>(`/api/v1/handoffs/${initial.id}`), enabled: open, refetchInterval: open ? 3000 : false });
  const taskQuery = useQuery({ queryKey: ['task', initial.taskId], queryFn: () => api<Task>(`/api/tasks/${initial.taskId}?includeArchived=true`), enabled: open && !task });
  const handoff = detail.data ?? initial;
  const [sourcePath, setSourcePath] = useState('');
  const [inputFiles, setInputFiles] = useState('');
  const [inputFilesEdited, setInputFilesEdited] = useState(false);
  const [answer, setAnswer] = useState('');
  const [revisedInstruction, setRevisedInstruction] = useState<string | null>(null);
  const [completeChildren, setCompleteChildren] = useState(false);
  const [stoppedVerified, setStoppedVerified] = useState(false);
  const [extraWrite, setExtraWrite] = useState(false);
  const [extraShell, setExtraShell] = useState(false);
  const [changePermissions, setChangePermissions] = useState(false);
  const { run, busy } = usePlatformAction();
  const actualTask = task ?? taskQuery.data;
  return <article className="glass-subtle space-y-3 rounded-xl border p-4"><button type="button" className="flex w-full flex-wrap justify-between gap-2 text-left" aria-expanded={open} onClick={() => setOpen(!open)}><strong className="min-w-0 break-words text-sm">{actualTask?.title ?? handoff.instruction?.split('\n')[0] ?? handoff.taskId}</strong><span className="text-xs text-muted-foreground">{handoff.provider} · {stateNames[handoff.status] ?? handoff.status}</span></button>{open && <>
    <p className="whitespace-pre-wrap break-words text-sm">{handoff.instruction}</p>{handoff.status === 'prepared' && !handoff.runs?.length && <div className="space-y-2">{revisedInstruction === null ? <Button size="sm" variant="ghost" onClick={() => setRevisedInstruction(handoff.instruction)}>编辑交接目标与验收说明</Button> : <><Textarea aria-label="修改交接说明" value={revisedInstruction} onChange={(event) => setRevisedInstruction(event.target.value)} /><Button size="sm" disabled={busy || !actualTask || !revisedInstruction.trim()} onClick={() => void run(async () => { const result = await api(`/api/v1/handoffs/${handoff.id}`, { method: 'PATCH', body: json({ expectedRevision: handoff.revision, expectedTaskRevision: actualTask?.revision, instruction: revisedInstruction }) }); setRevisedInstruction(null); return result; }, '已保存新的交接版本')}>保存交接版本</Button></>}</div>}
    <details><summary className="cursor-pointer text-xs text-muted-foreground">冻结的上下文</summary><pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(parseStored(handoff.inputSnapshot, {}), null, 2)}</pre></details>
    {handoff.mode === 'manual' ? <p className="rounded-lg bg-muted p-3 text-xs">在已连接的 {handoff.provider} 会话中，请它使用 get_handoff 读取 {handoff.id}，再调用 claim_handoff 领取。</p> : <div className="space-y-2"><Input aria-label="执行项目目录" placeholder="本机项目的绝对路径" disabled={busy} value={sourcePath} onChange={(event) => setSourcePath(event.target.value)} /><p className="text-xs text-muted-foreground">Git 项目从当前 HEAD 创建副本，未提交内容不会带入；完成后可预览变更。</p><details><summary className="cursor-pointer text-xs">非 Git 目录：选择输入文件</summary><Textarea className="mt-2" aria-label="非 Git 输入文件" placeholder={'每行一个相对文件路径，例如：\nnotes/需求.md\n参考.txt'} disabled={busy} value={inputFiles} onChange={(event) => { setInputFiles(event.target.value); setInputFilesEdited(true); }} /><p className="mt-1 text-xs text-muted-foreground">仅复制列出的文件到独立目录，最多 100 个、合计 32 MiB；留空则从空目录开始。Git 项目请留空。</p></details><Button size="sm" disabled={busy || !sourcePath.trim() || handoff.status !== 'prepared'} onClick={() => void run(() => api(`/api/v1/handoffs/${handoff.id}/start`, { method: 'POST', body: json({ sourcePath, inputFiles: inputFiles.split(/\r?\n/).map((path) => path.trim()).filter(Boolean), requestId: crypto.randomUUID() }) }), '已启动执行')}>一键启动 {handoff.provider === 'codex' ? 'Codex' : 'Claude Code'}</Button></div>}
    {(handoff.runs ?? []).map((execution: any) => {
      const result = parseStored<Record<string, any>>(execution.resultJson ?? execution.result, {});
      const workspace = parseStored<Record<string, any>>(execution.workspaceJson ?? execution.workspace, {});
      return <section className="space-y-3 border-t pt-3" key={execution.id}><p className="text-xs text-muted-foreground">{stateNames[execution.status] ?? execution.status} · {new Date(execution.createdAt).toLocaleString()}</p>{execution.error && <p role="alert" className="text-sm text-destructive">{execution.error}</p>}{result.summary && <p className="whitespace-pre-wrap text-sm">{result.summary}</p>}{result.unfinished?.length > 0 && <p className="text-sm">未完成项：{result.unfinished.join('；')}</p>}{result.proposedCommands?.length > 0 && <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => api(`/api/v1/runs/${execution.id}/proposals`, { method: 'POST', body: '{}' }), '结果中的修改已加入待确认')}>将结果中的修改整理为提议</Button>}{(result.questions ?? []).map((question: string) => <p className="text-sm" key={question}>{question}</p>)}
        <RunEvents runId={execution.id} />
        {workspace.inputs?.length > 0 && <details><summary className="cursor-pointer text-xs text-muted-foreground">本次输入快照 · {workspace.inputs.length} 个文件</summary><ul className="mt-2 space-y-2 text-xs">{workspace.inputs.map((file: any) => <li className="break-all" key={file.path}>{file.path} · {file.size} 字节<code className="mt-1 block text-muted-foreground">SHA-256 {file.hash}</code></li>)}</ul></details>}
        <RunArtifacts runId={execution.id} workspace={workspace} />
        {execution.status === 'returned' && actualTask?.children?.some((child) => child.status !== 'done') && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={completeChildren} onChange={(event) => setCompleteChildren(event.target.checked)} />采纳并完成时，一并完成剩余子任务</label>}
        <div className="flex flex-wrap gap-2">
          {execution.status === 'returned' && <><Button size="sm" disabled={busy || !actualTask} onClick={() => void run(() => api(`/api/v1/handoffs/${handoff.id}/review`, { method: 'POST', body: json({ runId: execution.id, decision: 'accept', expectedTaskRevision: actualTask?.revision }) }), '结果已采纳')}>采纳结果</Button><Button size="sm" variant="outline" disabled={busy || !actualTask} onClick={() => void run(() => api(`/api/v1/handoffs/${handoff.id}/review`, { method: 'POST', body: json({ runId: execution.id, decision: 'accept', expectedTaskRevision: actualTask?.revision, completeTask: true, completeChildren, expectedChildRevisions: Object.fromEntries((actualTask?.children ?? []).map((child) => [child.id, child.revision])) }) }), '已采纳并完成任务')}>采纳并完成任务</Button><Button size="sm" variant="ghost" disabled={busy || !actualTask} onClick={() => void run(() => api(`/api/v1/handoffs/${handoff.id}/review`, { method: 'POST', body: json({ runId: execution.id, decision: 'reject', expectedTaskRevision: actualTask?.revision }) }), '已记录返工')}>要求返工</Button></>}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => api(`/api/v1/runs/${execution.id}/reconcile`, { method: 'POST', body: '{}' }), '已核实执行记录')}>刷新执行记录</Button>
          {['created', 'accepted', 'running', 'unknown'].includes(execution.status) && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => api(`/api/v1/runs/${execution.id}/cancel`, { method: 'POST', body: '{}' }), '已提交停止请求')}>{execution.mode === 'manual' ? '撤销交接授权' : '停止执行'}</Button>}
        </div>
        {execution.status === 'unknown' && <div className="space-y-2 text-xs"><label className="flex items-center gap-2"><input type="checkbox" checked={stoppedVerified} onChange={(event) => setStoppedVerified(event.target.checked)} />我已在系统中核实本次执行的进程及子进程均已停止</label><Button size="sm" variant="outline" disabled={busy || !stoppedVerified} onClick={() => void run(() => api(`/api/v1/runs/${execution.id}/confirm-stopped`, { method: 'POST', body: json({ confirmedStopped: true }) }), '已记录人工核实')}>记录已停止</Button></div>}
        {execution.mode === 'local' && ['returned', 'failed', 'cancelled', 'interrupted'].includes(execution.status) && <div className="space-y-2">{execution.mode === 'local' && <div className="space-y-2 text-xs"><label className="flex items-center gap-2"><input type="checkbox" checked={changePermissions} onChange={(event) => setChangePermissions(event.target.checked)} />为下一次运行调整权限</label>{changePermissions && <><label className="flex items-center gap-2"><input type="checkbox" checked={extraWrite} onChange={(event) => setExtraWrite(event.target.checked)} />允许修改独立副本</label><label className="flex items-center gap-2"><input type="checkbox" checked={extraShell} onChange={(event) => setExtraShell(event.target.checked)} />允许运行项目命令</label></>}</div>}{!execution.externalSessionId && <p className="text-xs text-muted-foreground">本次执行没有已登记的宿主会话，重试将开启新会话并保留与此次记录的关联。{!workspace.workPath && '可在上方修正源目录和输入文件；未修改的选择沿用上次设置。'}</p>}<Input aria-label="继续执行的补充说明" value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="补充说明，开始新的执行" /><Button size="sm" disabled={busy || !answer.trim()} onClick={() => void run(async () => { const result = await api(`/api/v1/runs/${execution.id}/continue`, { method: 'POST', body: json({ answer, ...(!workspace.workPath ? { ...(sourcePath.trim() ? { sourcePath: sourcePath.trim() } : {}), ...(inputFilesEdited ? { inputFiles: inputFiles.split(/\r?\n/).map((path) => path.trim()).filter(Boolean) } : {}) } : {}), ...(changePermissions ? { permissions: { profile: extraWrite ? 'workspace_write' : 'read_only', allowShell: extraShell } } : {}), requestId: crypto.randomUUID() }) }); setAnswer(''); return result; }, '已创建后续执行')}>{execution.externalSessionId ? '继续' : '新会话重试'}</Button></div>}
      </section>;
    })}
  </>}</article>;
}
function RunArtifacts({ runId, workspace }: { runId: string; workspace: Record<string, any> }) {
  const query = useQuery({ queryKey: ['artifacts', runId], queryFn: () => api<any[]>(`/api/v1/runs/${runId}/artifacts`) });
  const { run, busy } = usePlatformAction();
  const [previewed, setPreviewed] = useState<{ id: string; content: string; name: string; encoding: string } | null>(null);
  function download() {
    if (!previewed) return;
    const content = previewed.encoding === 'base64' ? Uint8Array.from(atob(previewed.content), (char) => char.charCodeAt(0)) : previewed.content;
    const url = URL.createObjectURL(new Blob([content]));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = previewed.name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <div className="space-y-2">{(query.data ?? []).map((artifact) => <div className="rounded-lg border p-3" key={artifact.id}><div className="flex flex-wrap items-center gap-3 text-sm"><strong>{artifact.name}</strong><Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(async () => { const result = await api<any>(`/api/v1/artifacts/${artifact.id}/content`); setPreviewed({ ...result, id: artifact.id }); return result; }, '产物已载入')}>查看产物</Button>{artifact.kind === 'git_patch' && <Button size="sm" variant="outline" disabled={busy || previewed?.id !== artifact.id} onClick={() => void run(() => api(`/api/v1/runs/${runId}/apply`, { method: 'POST', body: json({ artifactId: artifact.id, expectedHead: workspace.baseHead ?? workspace.head ?? parseStored<any>(artifact.metadata, {}).baseHead, requestId: crypto.randomUUID() }) }), '代码变更已应用')}>应用已预览的变更</Button>}</div>{previewed && previewed.id === artifact.id && <><pre className="my-3 max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">{previewed.encoding === 'utf8' ? previewed.content : '二进制产物，可下载原文件。'}</pre><Button size="sm" variant="outline" onClick={download}>下载产物</Button></>}</div>)}</div>;
}

function RunEvents({ runId }: { runId: string }) {
  const query = useInfiniteQuery({ queryKey: ['run-events', runId], initialPageParam: 0, queryFn: ({ pageParam }) => api<{ items: any[]; nextCursor: number | null }>(`/api/v1/runs/${runId}/events?afterSequence=${pageParam}`), getNextPageParam: (page) => page.nextCursor ?? undefined, refetchInterval: 3000 });
  return <details><summary className="cursor-pointer text-xs text-muted-foreground">执行进展与日志</summary><div className="mt-2 max-h-64 space-y-2 overflow-auto">{query.error && <p role="alert">{query.error.message}</p>}{query.data?.pages.flatMap((page) => page.items).map((event) => <div key={event.id ?? event.sequence} className="border-t pt-2 text-xs"><p>{new Date(event.createdAt).toLocaleString()} · {event.type}</p><pre className="whitespace-pre-wrap break-all">{JSON.stringify(parseStored(event.payload, {}), null, 2)}</pre></div>)}{query.hasNextPage && <Button size="sm" variant="ghost" onClick={() => void query.fetchNextPage()}>加载后续执行日志</Button>}</div></details>;
}
