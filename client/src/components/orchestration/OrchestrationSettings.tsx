import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';

type NodeRow = { id: string; name: string; status: string; online: boolean; lastSeenAt: string | null; platform: string; capabilities: { providers?: Array<{ provider: string; available: boolean; version: string }>; allowedRoots?: string[]; maxConcurrent?: number } };
type Location = { id: string; nodeId: string; nodeName: string; nodeOnline: boolean; path: string; status: string; error: string | null };
type Project = { id: string; name: string; defaultBranch: string; defaultProvider: string; revision: number; locations: Location[] };
type Topic = { id: string; name: string };
const locationStatus: Record<string, string> = { pending: '等待执行端验证', verified: '已验证', failed: '验证失败' };

/** Local executors, projects with their per-node locations, and list default projects. */
export function OrchestrationSettings() {
  const client = useQueryClient();
  const nodes = useQuery({ queryKey: ['nodes'], queryFn: () => api<NodeRow[]>('/api/nodes'), refetchInterval: 10_000 });
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<Project[]>('/api/projects'), refetchInterval: 5_000 });
  const topics = useQuery({ queryKey: ['topics', 'orchestration-settings'], queryFn: () => api<Topic[]>('/api/topics') });
  const [nodeName, setNodeName] = useState('');
  const [issued, setIssued] = useState<{ command: string; token: string } | null>(null);
  const [project, setProject] = useState({ name: '', defaultBranch: 'main', defaultProvider: 'codex' });
  const refresh = () => { void client.invalidateQueries({ queryKey: ['nodes'] }); void client.invalidateQueries({ queryKey: ['projects'] }); };
  const createNode = useMutation({ mutationFn: () => api<{ command: string; token: string }>('/api/nodes', { method: 'POST', body: JSON.stringify({ name: nodeName.trim() }) }), onSuccess: (data) => { setIssued(data); setNodeName(''); refresh(); }, onError: (error) => toast.error(error.message) });
  const revoke = useMutation({ mutationFn: (id: string) => api(`/api/nodes/${id}/revoke`, { method: 'POST', body: '{}' }), onSuccess: refresh, onError: (error) => toast.error(error.message) });
  const createProject = useMutation({ mutationFn: () => api('/api/projects', { method: 'POST', body: JSON.stringify(project) }), onSuccess: () => { setProject({ name: '', defaultBranch: 'main', defaultProvider: 'codex' }); refresh(); }, onError: (error) => toast.error(error.message) });
  const activeNodes = (nodes.data ?? []).filter((node) => node.status === 'active');
  return <section className="mt-8 border-t pt-8" aria-label="主控编排设置">
    <h2 className="text-lg font-semibold">主控编排</h2>
    <p className="mt-1 text-sm text-muted-foreground">WWA 服务可以跑在远端服务器上。真正写代码、合入、跑测试的是你电脑上的「本机执行端」：它主动连到这里领任务，在本机启动 Codex / Claude。服务端看不到你的文件。</p>

    <h3 className="mt-6 font-medium">本机执行端</h3>
    <ul className="mt-2 space-y-2 text-sm">{activeNodes.map((node) => <li key={node.id} className="rounded border p-2">
      <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{node.name}</span><span className={node.online ? 'text-green-600' : 'text-muted-foreground'}>{node.online ? '在线' : node.lastSeenAt ? '离线' : '尚未连接'}</span><span className="text-xs text-muted-foreground">{node.platform}</span>
        <Button size="sm" variant="ghost" className="ml-auto text-destructive" onClick={() => revoke.mutate(node.id)}>吊销</Button></div>
      {node.capabilities.allowedRoots?.length ? <div className="text-xs text-muted-foreground">允许目录：{node.capabilities.allowedRoots.join('，')} · 并发 {node.capabilities.maxConcurrent ?? '-'} · {(node.capabilities.providers ?? []).filter((item) => item.available).map((item) => item.provider).join('/') || '没有可用的 CLI'}</div> : null}
    </li>)}</ul>
    <form className="mt-2 flex gap-2" onSubmit={(event) => { event.preventDefault(); if (nodeName.trim()) createNode.mutate(); }}>
      <Input value={nodeName} onChange={(event) => setNodeName(event.target.value)} placeholder="执行端名称，例如：我的笔记本" className="max-w-xs" /><Button disabled={!nodeName.trim() || createNode.isPending}>新建执行端</Button>
    </form>
    {issued && <div role="status" className="mt-2 space-y-1 rounded bg-muted p-2 text-xs"><p>在你的电脑上（WWA 源码目录里）运行下面的命令。令牌只显示这一次；<code>--roots</code> 填允许执行端访问的代码目录，只能在本机修改。</p><code className="block break-all">{issued.command}</code><Button size="sm" variant="ghost" onClick={() => { void navigator.clipboard?.writeText(issued.command); toast.success('已复制'); }}>复制命令</Button></div>}

    <h3 className="mt-6 font-medium">项目</h3>
    <div className="mt-2 space-y-3 text-sm">{projects.data?.map((item) => <ProjectCard key={item.id} project={item} nodes={activeNodes} onChanged={refresh} />)}</div>
    <form className="mt-2 flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); if (project.name.trim()) createProject.mutate(); }}>
      <Input value={project.name} onChange={(event) => setProject({ ...project, name: event.target.value })} placeholder="项目名称" className="max-w-[12rem]" />
      <Input value={project.defaultBranch} onChange={(event) => setProject({ ...project, defaultBranch: event.target.value })} placeholder="默认分支" className="max-w-[8rem]" />
      <select className="rounded border bg-background px-2" value={project.defaultProvider} onChange={(event) => setProject({ ...project, defaultProvider: event.target.value })}><option value="codex">Codex</option><option value="claude">Claude</option></select>
      <Button disabled={!project.name.trim() || createProject.isPending}>新建项目</Button>
    </form>

    <h3 className="mt-6 font-medium">清单默认项目</h3>
    <ul className="mt-2 space-y-1 text-sm">{topics.data?.map((topic) => <TopicBinding key={topic.id} topic={topic} projects={projects.data ?? []} />)}</ul>
  </section>;
}

function ProjectCard({ project, nodes, onChanged }: { project: Project; nodes: NodeRow[]; onChanged: () => void }) {
  const [nodeId, setNodeId] = useState(nodes[0]?.id ?? '');
  const [path, setPath] = useState('');
  const add = useMutation({ mutationFn: () => api(`/api/projects/${project.id}/locations`, { method: 'POST', body: JSON.stringify({ nodeId: nodeId || nodes[0]?.id, path: path.trim() }) }), onSuccess: () => { setPath(''); onChanged(); toast.info('已交给执行端验证路径'); }, onError: (error) => toast.error(error.message) });
  const remove = useMutation({ mutationFn: (id: string) => api(`/api/projects/${project.id}/locations/${id}`, { method: 'DELETE' }), onSuccess: onChanged, onError: (error) => toast.error(error.message) });
  return <div className="rounded border p-2">
    <div className="font-medium">{project.name} <span className="text-xs font-normal text-muted-foreground">默认分支 {project.defaultBranch} · {project.defaultProvider}</span></div>
    <ul className="mt-1 space-y-1">{project.locations.map((location) => <li key={location.id} className="flex flex-wrap items-center gap-2 text-xs"><span>{location.nodeName}</span><code className="break-all">{location.path}</code><span className={location.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}>{locationStatus[location.status] ?? location.status}{location.error ? `：${location.error}` : ''}</span><Button size="sm" variant="ghost" onClick={() => remove.mutate(location.id)}>移除</Button></li>)}</ul>
    {nodes.length > 0 && <form className="mt-1 flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); if (path.trim()) add.mutate(); }}>
      <select className="rounded border bg-background px-2 text-xs" value={nodeId} onChange={(event) => setNodeId(event.target.value)}>{nodes.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}</select>
      <Input value={path} onChange={(event) => setPath(event.target.value)} placeholder="该执行端上的仓库绝对路径" className="h-8 max-w-sm text-xs" /><Button size="sm" disabled={!path.trim() || add.isPending}>添加位置</Button>
    </form>}
  </div>;
}

function TopicBinding({ topic, projects }: { topic: Topic; projects: Project[] }) {
  const client = useQueryClient();
  const binding = useQuery({ queryKey: ['project-binding', 'topic', topic.id], queryFn: () => api<{ projectId: string | null }>(`/api/project-bindings/topic/${topic.id}`) });
  const save = useMutation({ mutationFn: (projectId: string | null) => api(`/api/project-bindings/topic/${topic.id}`, { method: 'PUT', body: JSON.stringify({ projectId }) }), onSuccess: () => void client.invalidateQueries({ queryKey: ['project-binding'] }), onError: (error) => toast.error(error.message) });
  return <li className="flex items-center gap-2"><span className="w-40 truncate">{topic.name}</span><select className="rounded border bg-background px-2 py-0.5" value={binding.data?.projectId ?? ''} onChange={(event) => save.mutate(event.target.value || null)}><option value="">（无）</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></li>;
}
