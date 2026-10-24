import { Surface } from '@/components/ui/surface.js';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { Button } from '@/components/ui/button.js';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible.js';
import { Input } from '@/components/ui/input.js';
import { Label } from '@/components/ui/label.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.js';
import { Skeleton } from '@/components/ui/skeleton.js';
import { ArchivedProjectCard, ProjectCard } from './ProjectCard.js';
import { engineLabel, isBranchName, topicsWithoutProject } from './logic.js';
import type { Computer, ProjectRow, TopicBindingItem, TopicRow } from './types.js';

const engines = ['codex', 'claude'] as const;

export function ProjectsSettings() {
  const { t } = useTranslation('settings');
  const client = useQueryClient();
  const nodes = useQuery({ queryKey: ['nodes'], queryFn: () => api<Computer[]>('/api/nodes') });
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<ProjectRow[]>('/api/projects'), refetchInterval: 10_000 });
  const archived = useQuery({ queryKey: ['projects', 'archived'], queryFn: () => api<ProjectRow[]>('/api/projects?archived=1') });
  const topics = useQuery({ queryKey: ['topics'], queryFn: () => api<TopicRow[]>('/api/topics') });
  const bindings = useQuery({ queryKey: ['project-bindings', 'topic'], queryFn: () => api<{ items: TopicBindingItem[] }>('/api/project-bindings?scopeType=topic') });
  const [name, setName] = useState('');
  const [branch, setBranch] = useState('main');
  const [provider, setProvider] = useState('codex');
  const [parallel, setParallel] = useState('2');
  const create = useMutation({
    mutationFn: () => api('/api/projects', { method: 'POST', body: JSON.stringify({ name: name.trim(), defaultBranch: branch.trim(), defaultProvider: provider, defaultParallel: Number(parallel) }) }),
    onSuccess: async () => {
      setName('');
      setBranch('main');
      setProvider('codex');
      setParallel('2');
      await client.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const branchOk = isBranchName(branch);
  const unbound = topics.data && bindings.data ? topicsWithoutProject(topics.data, bindings.data.items ?? []) : [];
  const archivedRows = archived.data ?? [];
  return (
    <section aria-label={t('projects.aria')}>
      <p className="text-[13px] leading-relaxed text-muted-foreground">{t('projects.lead')}</p>
      {projects.isLoading ? <Skeleton className="mt-4 h-24 w-full" /> : projects.isError ? (
        <p role="alert" className="mt-4 text-sm text-destructive">{projects.error instanceof Error ? projects.error.message : t('projects.loadFailed')}<Button type="button" size="sm" variant="ghost" onClick={() => void projects.refetch()}>{t('actions.retry')}</Button></p>
      ) : (projects.data ?? []).length === 0 ? <p className="mt-4 text-sm text-muted-foreground">{t('projects.empty')}</p> : (
        <div className="mt-4 space-y-3">{projects.data?.map((project) => <ProjectCard key={project.id} project={project} nodes={nodes.data ?? []} topics={topics.data ?? []} />)}</div>
      )}
      <Surface as="form" tone="subtle" aria-label={t('projects.create.form')} className="mt-4 space-y-3 rounded-xl p-4" onSubmit={(event) => { event.preventDefault(); if (name.trim() && branchOk) create.mutate(); }}>
        <h3 className="text-sm font-medium">{t('projects.create.form')}</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="new-project-name">{t('projects.create.name')}</Label>
            <Input id="new-project-name" value={name} maxLength={100} placeholder={t('projects.create.namePlaceholder')} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="new-project-branch">{t('projects.fields.branch')}</Label>
            <Input id="new-project-branch" aria-label={t('projects.fields.branch')} value={branch} maxLength={200} onChange={(event) => setBranch(event.target.value)} />
            {!branchOk && <p className="text-xs text-destructive">{t('projects.card.branchInvalid')}</p>}
          </div>
          <div className="space-y-1">
            <Label htmlFor="new-project-engine">{t('projects.fields.engine')}</Label>
            <Select value={provider} onValueChange={setProvider}>
              <SelectTrigger id="new-project-engine" type="button" aria-label={t('projects.fields.engine')}><SelectValue /></SelectTrigger>
              <SelectContent>{engines.map((engine) => <SelectItem key={engine} value={engine}>{engineLabel(engine)}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="new-project-parallel">{t('projects.fields.parallel')}</Label>
            <Select value={parallel} onValueChange={setParallel}>
              <SelectTrigger id="new-project-parallel" type="button" aria-label={t('projects.fields.parallel')}><SelectValue /></SelectTrigger>
              <SelectContent>{[1, 2, 3, 4].map((value) => <SelectItem key={value} value={String(value)}>{String(value)}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
        <Button type="submit" size="sm" disabled={!name.trim() || !branchOk || create.isPending}>{t('projects.create.submit')}</Button>
      </Surface>
      {archivedRows.length > 0 && (
        <Collapsible className="mt-4">
          <CollapsibleTrigger type="button" className="group flex w-full items-center gap-2 rounded-lg px-1 py-2 text-left text-sm text-muted-foreground hover:text-foreground">
            <ChevronDown aria-hidden="true" className="size-4 transition-transform group-data-[state=open]:rotate-180" />
            {t('projects.archived.title', { count: archivedRows.length })}
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-2 pt-2">
            {archivedRows.map((project) => <ArchivedProjectCard key={project.id} project={project} />)}
          </CollapsibleContent>
        </Collapsible>
      )}
      <div className="mt-6 space-y-2">
        <h3 className="text-lg font-semibold">{t('projects.unbound.title')}</h3>
        <p className="text-[13px] leading-relaxed text-muted-foreground">{t('projects.unbound.lead')}</p>
        {topics.isSuccess && bindings.isSuccess ? (
          unbound.length === 0 ? <p className="text-sm text-muted-foreground">{t('projects.unbound.empty')}</p> : (
            <ul className="space-y-1 text-sm">{unbound.map((topic) => <li key={topic.id}>{topic.name}</li>)}</ul>
          )
        ) : <Skeleton className="h-8 w-full" />}
      </div>
    </section>
  );
}
