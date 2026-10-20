import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { inDesktopShell, notificationMode, notificationSupport, pairNodeOnThisComputer, requestNotificationPermission, setNotificationMode, stopNodeOnThisComputer } from '@/lib/desktop-shell.js';
import { locationStatusLabels } from './labels.js';

type NodeRow = { id: string; name: string; status: string; online: boolean; lastSeenAt: string | null; platform: string; capabilities: { providers?: Array<{ provider: string; available: boolean; version: string }>; allowedRoots?: string[]; maxConcurrent?: number } };
type Location = { id: string; nodeId: string; nodeName: string; nodeOnline: boolean; path: string; status: string; error: string | null };
type Project = { id: string; name: string; defaultBranch: string; defaultProvider: string; revision: number; locations: Location[] };
type Topic = { id: string; name: string };

/** Local executors, projects with their per-node locations, and list default projects. */
export function OrchestrationSettings() {
  const { t } = useTranslation('orchestration');
  const client = useQueryClient();
  const nodes = useQuery({ queryKey: ['nodes'], queryFn: () => api<NodeRow[]>('/api/nodes'), refetchInterval: 10_000 });
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<Project[]>('/api/projects'), refetchInterval: 5_000 });
  const topics = useQuery({ queryKey: ['topics', 'orchestration-settings'], queryFn: () => api<Topic[]>('/api/topics') });
  const [nodeName, setNodeName] = useState('');
  const [issued, setIssued] = useState<{ command: string; token: string; serverUrl: string } | null>(null);
  const [project, setProject] = useState({ name: '', defaultBranch: 'main', defaultProvider: 'codex' });
  const refresh = () => { void client.invalidateQueries({ queryKey: ['nodes'] }); void client.invalidateQueries({ queryKey: ['projects'] }); };
  const createNode = useMutation({ mutationFn: () => api<{ command: string; token: string; serverUrl: string }>('/api/nodes', { method: 'POST', body: JSON.stringify({ name: nodeName.trim() }) }), onSuccess: (data) => { setIssued(data); setNodeName(''); refresh(); }, onError: (error) => toast.error(error.message) });
  const revoke = useMutation({ mutationFn: (id: string) => api(`/api/nodes/${id}/revoke`, { method: 'POST', body: '{}' }), onSuccess: refresh, onError: (error) => toast.error(error.message) });
  const createProject = useMutation({ mutationFn: () => api('/api/projects', { method: 'POST', body: JSON.stringify(project) }), onSuccess: () => { setProject({ name: '', defaultBranch: 'main', defaultProvider: 'codex' }); refresh(); }, onError: (error) => toast.error(error.message) });
  const activeNodes = (nodes.data ?? []).filter((node) => node.status === 'active');
  const desktop = inDesktopShell();
  return <section className="mt-8 border-t pt-8" aria-label={t('settings.aria')}>
    <h2 className="text-lg font-semibold">{t('settings.title')}</h2>
    <p className="mt-1 text-sm text-muted-foreground">{t('settings.description')}</p>

    <h3 className="mt-6 font-medium">{t('settings.nodesTitle')}</h3>
    <ul className="mt-2 space-y-2 text-sm">{activeNodes.map((node) => <li key={node.id} className="rounded border p-2">
      <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{node.name}</span><span className={node.online ? 'text-green-600' : 'text-muted-foreground'}>{node.online ? t('settings.online') : node.lastSeenAt ? t('settings.offline') : t('settings.neverConnected')}</span><span className="text-xs text-muted-foreground">{node.platform}</span>
        <Button size="sm" variant="ghost" className="ml-auto text-destructive" onClick={() => revoke.mutate(node.id)}>{t('settings.revoke')}</Button></div>
      {node.capabilities.allowedRoots?.length ? <div className="text-xs text-muted-foreground">{t('settings.roots', { roots: node.capabilities.allowedRoots.join(t('settings.rootSep')), max: node.capabilities.maxConcurrent ?? '-', cli: (node.capabilities.providers ?? []).filter((item) => item.available).map((item) => item.provider).join('/') || t('settings.noCli') })}</div> : null}
    </li>)}</ul>
    <form className="mt-2 flex gap-2" onSubmit={(event) => { event.preventDefault(); if (nodeName.trim()) createNode.mutate(); }}>
      <Input value={nodeName} onChange={(event) => setNodeName(event.target.value)} placeholder={t('settings.nodeName')} className="max-w-xs" /><Button disabled={!nodeName.trim() || createNode.isPending}>{t('settings.createNode')}</Button>
    </form>
    {issued && <div role="status" className="mt-2 space-y-1 rounded bg-muted p-2 text-xs"><p>{t('settings.commandBefore')}<code>--roots</code>{t('settings.commandAfter')}</p><code className="block break-all">{issued.command}</code><Button size="sm" variant="ghost" onClick={() => { void navigator.clipboard?.writeText(issued.command); toast.success(t('settings.copied')); }}>{t('settings.copy')}</Button>
      {desktop && <div className="border-t pt-2"><p>{t('settings.pairHint')}</p><Button size="sm" onClick={() => { pairNodeOnThisComputer(issued.serverUrl, issued.token); setIssued(null); }}>{t('settings.pair')}</Button></div>}</div>}
    {desktop && <p className="mt-2 text-xs text-muted-foreground">{t('settings.managedBefore')}<Button size="sm" variant="ghost" onClick={() => stopNodeOnThisComputer()}>{t('settings.unpair')}</Button>{t('settings.managedAfter')}</p>}

    <NotificationSetting />

    <h3 className="mt-6 font-medium">{t('settings.projects')}</h3>
    <div className="mt-2 space-y-3 text-sm">{projects.data?.map((item) => <ProjectCard key={item.id} project={item} nodes={activeNodes} onChanged={refresh} />)}</div>
    <form className="mt-2 flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); if (project.name.trim()) createProject.mutate(); }}>
      <Input value={project.name} onChange={(event) => setProject({ ...project, name: event.target.value })} placeholder={t('settings.projectName')} className="max-w-[12rem]" />
      <Input value={project.defaultBranch} onChange={(event) => setProject({ ...project, defaultBranch: event.target.value })} placeholder={t('settings.defaultBranch')} className="max-w-[8rem]" />
      <select className="rounded border bg-background px-2" value={project.defaultProvider} onChange={(event) => setProject({ ...project, defaultProvider: event.target.value })}><option value="codex">Codex</option><option value="claude">Claude</option></select>
      <Button disabled={!project.name.trim() || createProject.isPending}>{t('settings.createProject')}</Button>
    </form>

    <h3 className="mt-6 font-medium">{t('settings.topicDefaults')}</h3>
    <ul className="mt-2 space-y-1 text-sm">{topics.data?.map((topic) => <TopicBinding key={topic.id} topic={topic} projects={projects.data ?? []} />)}</ul>
  </section>;
}

function ProjectCard({ project, nodes, onChanged }: { project: Project; nodes: NodeRow[]; onChanged: () => void }) {
  const { t } = useTranslation('orchestration');
  const [nodeId, setNodeId] = useState(nodes[0]?.id ?? '');
  const [path, setPath] = useState('');
  const add = useMutation({ mutationFn: () => api(`/api/projects/${project.id}/locations`, { method: 'POST', body: JSON.stringify({ nodeId: nodeId || nodes[0]?.id, path: path.trim() }) }), onSuccess: () => { setPath(''); onChanged(); toast.info(t('settings.verifying')); }, onError: (error) => toast.error(error.message) });
  const remove = useMutation({ mutationFn: (id: string) => api(`/api/projects/${project.id}/locations/${id}`, { method: 'DELETE' }), onSuccess: onChanged, onError: (error) => toast.error(error.message) });
  return <div className="rounded border p-2">
    <div className="font-medium">{project.name} <span className="text-xs font-normal text-muted-foreground">{t('settings.projectMeta', { branch: project.defaultBranch, provider: project.defaultProvider })}</span></div>
    <ul className="mt-1 space-y-1">{project.locations.map((location) => {
      const status = locationStatusLabels[location.status] ?? location.status;
      return <li key={location.id} className="flex flex-wrap items-center gap-2 text-xs"><span>{location.nodeName}</span><code className="break-all">{location.path}</code><span className={location.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}>{location.error ? t('settings.locationError', { status, error: location.error }) : status}</span><Button size="sm" variant="ghost" onClick={() => remove.mutate(location.id)}>{t('settings.remove')}</Button></li>;
    })}</ul>
    {nodes.length > 0 && <form className="mt-1 flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); if (path.trim()) add.mutate(); }}>
      <select className="rounded border bg-background px-2 text-xs" value={nodeId} onChange={(event) => setNodeId(event.target.value)}>{nodes.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}</select>
      <Input value={path} onChange={(event) => setPath(event.target.value)} placeholder={t('settings.pathPlaceholder')} className="h-8 max-w-sm text-xs" /><Button size="sm" disabled={!path.trim() || add.isPending}>{t('settings.addLocation')}</Button>
    </form>}
  </div>;
}

function TopicBinding({ topic, projects }: { topic: Topic; projects: Project[] }) {
  const { t } = useTranslation('orchestration');
  const client = useQueryClient();
  const binding = useQuery({ queryKey: ['project-binding', 'topic', topic.id], queryFn: () => api<{ projectId: string | null }>(`/api/project-bindings/topic/${topic.id}`) });
  const save = useMutation({ mutationFn: (projectId: string | null) => api(`/api/project-bindings/topic/${topic.id}`, { method: 'PUT', body: JSON.stringify({ projectId }) }), onSuccess: () => void client.invalidateQueries({ queryKey: ['project-binding'] }), onError: (error) => toast.error(error.message) });
  return <li className="flex items-center gap-2"><span className="w-40 truncate">{topic.name}</span><select className="rounded border bg-background px-2 py-0.5" value={binding.data?.projectId ?? ''} onChange={(event) => save.mutate(event.target.value || null)}><option value="">{t('settings.none')}</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></li>;
}

/** System notifications when a round waits for acceptance or pauses. Off switch is per device. */
function NotificationSetting() {
  const { t } = useTranslation('orchestration');
  const [mode, setMode] = useState(notificationMode());
  const [support, setSupport] = useState(notificationSupport());
  const label = support === 'desktop' ? t('settings.supportDesktop') : support === 'granted' ? t('settings.supportGranted') : support === 'denied' ? t('settings.supportDenied') : support === 'unsupported' ? t('settings.supportUnsupported') : t('settings.supportDefault');
  return <div className="mt-4 text-sm"><h3 className="font-medium">{t('settings.notifications')}</h3>
    <label className="mt-1 flex items-center gap-2"><input type="checkbox" checked={mode === 'on'} onChange={(event) => { const next = event.target.checked ? 'on' : 'off'; setNotificationMode(next); setMode(next); }} /><span>{t('settings.notifyToggle')}</span></label>
    <p className="text-xs text-muted-foreground">{label}{support === 'default' && <Button size="sm" variant="ghost" onClick={() => { void requestNotificationPermission().then(() => setSupport(notificationSupport())); }}>{t('settings.allowNotify')}</Button>}</p>
  </div>;
}
