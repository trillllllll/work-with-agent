import { Surface } from '@/components/ui/surface.js';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Label } from '@/components/ui/label.js';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.js';
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog.js';
import { locationStatusLabels } from '@/components/orchestration/labels.js';
import { errorCode, errorDetails } from './errors.js';
import { defaultParallelLimit, engineLabel, isBranchName } from './logic.js';
import type { Computer, ProjectLocationRow, ProjectRow, TopicRow } from './types.js';

type BoundTopic = { topicId: string; projectId: string; projectName: string };
const engines = ['codex', 'claude'] as const;

export function ProjectCard({ project, nodes, topics }: { project: ProjectRow; nodes: Computer[]; topics: TopicRow[] }) {
  const { t } = useTranslation('settings');
  const client = useQueryClient();
  const [name, setName] = useState(project.name);
  const [branch, setBranch] = useState(project.defaultBranch);
  const [provider, setProvider] = useState(project.defaultProvider || 'codex');
  const [parallel, setParallel] = useState(String(project.defaultParallel ?? 2));
  const [topicIds, setTopicIds] = useState<string[]>(project.topicIds ?? []);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [nodeId, setNodeId] = useState('');
  const [path, setPath] = useState('');
  const [replacePath, setReplacePath] = useState<string | null>(null);
  const [bound, setBound] = useState<{ ids: string[]; bindings: BoundTopic[] } | null>(null);
  const activeNodes = nodes.filter((node) => node.status === 'active');
  const reports = project.locations.map((location) => {
    const node = nodes.find((item) => item.id === location.nodeId);
    const max = node?.capabilities?.maxConcurrent;
    return { name: location.nodeName, maxConcurrent: typeof max === 'number' ? max : null };
  });
  const cap = defaultParallelLimit(reports);
  useEffect(() => {
    setName(project.name);
    setBranch(project.defaultBranch);
    setProvider(project.defaultProvider || 'codex');
    setParallel(String(project.defaultParallel ?? 2));
    setTopicIds(project.topicIds ?? []);
  }, [project.id, project.revision]);
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ['projects'] });
    await client.invalidateQueries({ queryKey: ['project-bindings'] });
  };
  const save = useMutation({
    mutationFn: () => api(`/api/projects/${encodeURIComponent(project.id)}`, { method: 'PATCH', body: JSON.stringify({ name: name.trim(), defaultBranch: branch.trim(), defaultProvider: provider, defaultParallel: Number(parallel), expectedRevision: project.revision }) }),
    onSuccess: async () => { await refresh(); toast.success(t('projects.card.saved')); },
    onError: (error: Error) => { toast.error(error.message); if (errorCode(error) === 'VERSION_CONFLICT') void refresh(); },
  });
  const archive = useMutation({
    mutationFn: () => api(`/api/projects/${encodeURIComponent(project.id)}`, { method: 'PATCH', body: JSON.stringify({ archived: true, expectedRevision: project.revision }) }),
    onSuccess: async () => { await refresh(); setArchiveOpen(false); },
    onError: (error: Error) => { toast.error(error.message); if (errorCode(error) === 'VERSION_CONFLICT') void refresh(); },
  });
  const addLocation = useMutation({
    mutationFn: (replace: boolean) => api(`/api/projects/${encodeURIComponent(project.id)}/locations`, { method: 'POST', body: JSON.stringify({ nodeId: nodeId || activeNodes[0]?.id, path: path.trim(), ...(replace ? { replace: true } : {}) }) }),
    onSuccess: async () => { setPath(''); setReplacePath(null); await refresh(); toast.info(t('projects.location.verifying')); },
    onError: (error: Error) => {
      if (errorCode(error) === 'LOCATION_REPLACE') {
        const details = errorDetails<{ currentPath?: string }>(error);
        setReplacePath(details?.currentPath ?? '');
        return;
      }
      toast.error(error.message);
    },
  });
  const verify = useMutation({
    mutationFn: (locationId: string) => api(`/api/projects/${encodeURIComponent(project.id)}/locations/${encodeURIComponent(locationId)}/verify`, { method: 'POST', body: '{}' }),
    onSuccess: async () => { await refresh(); toast.info(t('projects.location.verifying')); },
    onError: (error: Error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: (locationId: string) => api(`/api/projects/${encodeURIComponent(project.id)}/locations/${encodeURIComponent(locationId)}`, { method: 'DELETE' }),
    onSuccess: async () => { setRemoveId(null); await refresh(); },
    onError: (error: Error) => toast.error(error.message),
  });
  const bind = useMutation({
    mutationFn: (input: { ids: string[]; replace: boolean }) => api(`/api/projects/${encodeURIComponent(project.id)}/topic-bindings`, { method: 'PUT', body: JSON.stringify({ topicIds: input.ids, ...(input.replace ? { replace: true } : {}), expectedRevision: project.revision }) }),
    onSuccess: async () => { setBound(null); await refresh(); },
    onError: (error: Error, input) => {
      if (!input.replace && errorCode(error) === 'TOPIC_BOUND') {
        const details = errorDetails<{ bindings?: BoundTopic[] }>(error);
        setBound({ ids: input.ids, bindings: details?.bindings ?? [] });
        return;
      }
      toast.error(error.message);
      setTopicIds(project.topicIds ?? []);
      if (errorCode(error) === 'VERSION_CONFLICT') void refresh();
    },
  });
  const branchOk = isBranchName(branch);
  const parallelValue = Number(parallel);
  const overCap = parallelValue > cap.limit;
  const chosenNode = nodeId || activeNodes[0]?.id || '';
  const toggleTopic = (id: string) => {
    const next = topicIds.includes(id) ? topicIds.filter((item) => item !== id) : [...topicIds, id];
    setTopicIds(next);
    bind.mutate({ ids: next, replace: false });
  };
  return (
    <Surface as="article" tone="subtle" className="space-y-4 rounded-xl p-4">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <Label htmlFor={`project-${project.id}-name`}>{t('projects.card.name')}</Label>
          <Input id={`project-${project.id}-name`} value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />
        </div>
        <Button type="button" size="sm" variant="ghost" className="text-destructive" onClick={() => setArchiveOpen(true)}>{t('projects.card.archive')}</Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor={`project-${project.id}-branch`}>{t('projects.fields.branch')}</Label>
          <Input id={`project-${project.id}-branch`} aria-label={t('projects.fields.branch')} value={branch} maxLength={200} onChange={(event) => setBranch(event.target.value)} />
          {!branchOk && <p className="text-xs text-destructive">{t('projects.card.branchInvalid')}</p>}
        </div>
        <div className="space-y-1">
          <Label htmlFor={`project-${project.id}-engine`}>{t('projects.fields.engine')}</Label>
          <Select value={provider} onValueChange={setProvider}>
            <SelectTrigger id={`project-${project.id}-engine`} aria-label={t('projects.fields.engine')}><SelectValue /></SelectTrigger>
            <SelectContent>{engines.map((engine) => <SelectItem key={engine} value={engine}>{engineLabel(engine)}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`project-${project.id}-parallel`}>{t('projects.fields.parallel')}</Label>
          <Select value={parallel} onValueChange={setParallel}>
            <SelectTrigger id={`project-${project.id}-parallel`} aria-label={t('projects.fields.parallel')}><SelectValue /></SelectTrigger>
            <SelectContent>
              {[1, 2, 3, 4].map((value) => (
                <SelectItem key={value} value={String(value)} disabled={value > cap.limit}>
                  {value > cap.limit ? t('projects.card.parallelOptionOver', { count: value, max: cap.limit }) : String(value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {cap.limit < 4 && <p className="text-xs text-muted-foreground">{cap.limiterName ? t('projects.card.parallelReason', { name: cap.limiterName, max: cap.limit }) : t('projects.card.parallelReasonPlain', { max: cap.limit })}</p>}
        </div>
      </div>
      <Button type="button" size="sm" disabled={!name.trim() || !branchOk || overCap || save.isPending} onClick={() => save.mutate()}>{t('projects.card.save')}</Button>
      <div className="space-y-2">
        <h5 className="text-sm font-medium">{t('projects.location.title')}</h5>
        <ul className="space-y-1 text-sm">
          {(project.locations ?? []).map((location) => (
            <li key={location.id} className="flex flex-wrap items-center gap-2">
              <span>{location.nodeName}</span>
              <code className="break-all text-xs">{location.path}</code>
              <span className={location.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}>{statusText(location, t)}</span>
              <Button type="button" size="sm" variant="ghost" disabled={verify.isPending} onClick={() => verify.mutate(location.id)}>{t('projects.location.verify')}</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setRemoveId(location.id)}>{t('projects.location.remove')}</Button>
            </li>
          ))}
        </ul>
        {activeNodes.length === 0 ? <p className="text-xs text-muted-foreground">{t('projects.location.noComputers')}</p> : (
          <form className="flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); if (path.trim() && chosenNode) addLocation.mutate(false); }}>
            <Select value={chosenNode} onValueChange={setNodeId}>
              <SelectTrigger size="sm" type="button" aria-label={t('projects.location.computer')}><SelectValue /></SelectTrigger>
              <SelectContent>{activeNodes.map((node) => <SelectItem key={node.id} value={node.id}>{node.name}</SelectItem>)}</SelectContent>
            </Select>
            <Input value={path} maxLength={4096} placeholder={t('projects.location.pathPlaceholder')} className="h-8 max-w-sm text-xs" aria-label={t('projects.location.path')} onChange={(event) => setPath(event.target.value)} />
            <Button type="submit" size="sm" disabled={!path.trim() || addLocation.isPending}>{t('projects.location.add')}</Button>
          </form>
        )}
      </div>
      <div className="space-y-2">
        <h5 className="text-sm font-medium">{t('projects.topics.title')}</h5>
        <p className="text-xs text-muted-foreground">{t('projects.topics.hint')}</p>
        <div className="flex flex-wrap gap-1">
          {topicIds.map((id) => {
            const topic = topics.find((item) => item.id === id);
            const label = topic?.name ?? id;
            return <Badge key={id} variant="secondary">{label}<Button variant="plain" size="bare" type="button" className="ml-1" aria-label={t('projects.topics.remove', { name: label })} disabled={bind.isPending} onClick={() => toggleTopic(id)}>×</Button></Badge>;
          })}
        </div>
        <Popover>
          <PopoverTrigger asChild><Button type="button" size="sm" variant="outline" disabled={bind.isPending}>{t('projects.topics.pick')}</Button></PopoverTrigger>
          <PopoverContent className="max-h-64 overflow-auto">
            {topics.length === 0 ? <p className="text-xs text-muted-foreground">{t('projects.topics.empty')}</p> : topics.map((topic) => (
              <Button variant="row" size="bare" key={topic.id} type="button" aria-pressed={topicIds.includes(topic.id)} disabled={bind.isPending} className="flex w-full items-center rounded-lg px-2 py-1.5 text-left text-sm hover:bg-[var(--glass-hover)] aria-pressed:font-medium" onClick={() => toggleTopic(topic.id)}>{topic.name}</Button>
            ))}
          </PopoverContent>
        </Popover>
      </div>
      {archiveOpen && <ConfirmDialog title={t('projects.card.archiveTitle')} itemName={project.name} description={t('projects.card.archiveDescription')} confirmLabel={t('projects.card.archiveConfirm')} busy={archive.isPending} onCancel={() => setArchiveOpen(false)} onConfirm={() => archive.mutate()} />}
      {removeId && <ConfirmDialog title={t('projects.location.removeTitle')} itemName={project.locations.find((location) => location.id === removeId)?.path ?? ''} description={t('projects.location.removeDescription')} busy={remove.isPending} onCancel={() => setRemoveId(null)} onConfirm={() => remove.mutate(removeId)} />}
      {replacePath !== null && <ConfirmDialog title={t('projects.location.replaceTitle')} itemName={replacePath} description={t('projects.location.replaceDescription', { path: replacePath })} confirmLabel={t('projects.location.replaceConfirm')} busy={addLocation.isPending} onCancel={() => setReplacePath(null)} onConfirm={() => addLocation.mutate(true)} />}
      {bound && (
        <ConfirmDialog title={t('projects.bound.title')} itemName={project.name} description={t('projects.bound.description')} confirmLabel={t('projects.bound.confirm')} busy={bind.isPending} onCancel={() => { setBound(null); setTopicIds(project.topicIds ?? []); }} onConfirm={() => bind.mutate({ ids: bound.ids, replace: true })}>
          <ul className="space-y-1 text-sm">
            {bound.bindings.map((item) => <li key={item.topicId}>{t('projects.bound.item', { topic: topics.find((topic) => topic.id === item.topicId)?.name ?? item.topicId, project: item.projectName })}</li>)}
          </ul>
        </ConfirmDialog>
      )}
    </Surface>
  );
}

export function ArchivedProjectCard({ project }: { project: ProjectRow }) {
  const { t } = useTranslation('settings');
  const client = useQueryClient();
  const restore = useMutation({
    mutationFn: () => api(`/api/projects/${encodeURIComponent(project.id)}`, { method: 'PATCH', body: JSON.stringify({ archived: false, expectedRevision: project.revision }) }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['projects'] });
      await client.invalidateQueries({ queryKey: ['project-bindings'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  return (
    <Surface as="div" tone="subtle" className="flex flex-wrap items-center gap-2 rounded-xl px-3 py-2 text-sm">
      <span className="font-medium">{project.name}</span>
      <Button type="button" size="sm" variant="outline" className="ml-auto" disabled={restore.isPending} onClick={() => restore.mutate()}>{t('projects.archived.restore')}</Button>
    </Surface>
  );
}

function statusText(location: ProjectLocationRow, t: (key: string, options?: Record<string, unknown>) => string) {
  const label = location.nodeStatus !== 'active'
    ? t('projects.location.disconnected')
    : location.status === 'pending' && !location.nodeOnline
      ? t('projects.location.offline')
      : (locationStatusLabels[location.status] ?? location.status);
  return location.error ? t('projects.location.error', { status: label, error: location.error }) : label;
}
