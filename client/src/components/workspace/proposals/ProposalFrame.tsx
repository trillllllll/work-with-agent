import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { relativeTime } from '@/components/workspace/memory-view.js';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible.js';
import { Button } from '@/components/ui/button.js';
import { groupNote, type ProposalAnalysis } from '@/lib/proposal-group.js';
import type { ConnectionName } from '@/lib/proposal-source.js';
import { proposalSource } from '@/lib/proposal-source.js';
import { impactLine, previewText, topicChips, typeLine, type TopicRef } from './present.js';
import type { Proposal } from './types.js';

function MetaSep() {
  return <span aria-hidden="true"> · </span>;
}

export function ProposalOrigin({ actorId, connectionId, connections, createdAt }: { actorId: string; connectionId?: string | null; connections?: ConnectionName[]; createdAt: string }) {
  const source = proposalSource(actorId, { connectionId, connections });
  const Icon = source.icon;
  const when = relativeTime(createdAt);
  return (
    <div className="flex flex-wrap items-center gap-2 px-1 text-xs text-muted-foreground">
      {Icon ? <Icon aria-hidden="true" className="size-3.5" /> : null}
      <span>{source.label}</span>
      {when ? <time dateTime={createdAt}>{when}</time> : null}
    </div>
  );
}

export function ProposalFrame({ proposal, analysis, connections, topics, state, selectable, selected, onSelected, selectionLocked = false, editing, error, onRefresh, footer, children }: {
  proposal: Proposal;
  analysis: ProposalAnalysis;
  connections?: ConnectionName[];
  topics?: TopicRef[];
  state: string;
  selectable: boolean;
  selected: boolean;
  onSelected: (selected: boolean) => void;
  selectionLocked?: boolean;
  editing: boolean;
  error: { message: string; conflict: boolean } | null;
  onRefresh: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation('proposals');
  const source = proposalSource(proposal.actorId, { connectionId: proposal.connectionId, connections });
  const Icon = source.icon;
  const kind = typeLine(analysis);
  const when = relativeTime(proposal.createdAt);
  const chips = topicChips(analysis.topicIds, topics);
  const note = groupNote(analysis, source.label);
  const impact = impactLine(analysis, topics);
  const targetIds = [...new Set(analysis.items.map((item) => item.command.targetId).filter((id): id is string => Boolean(id)))];
  const rawPreview = previewText(proposal.preview);
  return (
    <article data-testid="proposal-card" data-proposal-id={proposal.id} data-state={state} className="glass-subtle space-y-4 rounded-xl p-4">
      <div className="flex items-start gap-3">
        {selectable ? <input className="mt-1 size-4 shrink-0 accent-primary" type="checkbox" checked={selected} disabled={selectionLocked} aria-label={t('bulk.selectOne', { title: analysis.title })} onChange={(event) => onSelected(event.target.checked)} /> : null}
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            {Icon ? <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" /> : null}
            <h2 className="min-w-0 flex-1 break-words text-base font-semibold">{analysis.title}</h2>
          </div>
          <p className="mt-1 flex flex-wrap items-center text-xs text-muted-foreground">
            <span>{source.label}</span>
            {kind ? <><MetaSep /><span>{kind}</span></> : null}
            {chips.map((chip) => (
              <span key={chip.key} className="inline-flex items-center">
                <MetaSep />
                <span className="inline-flex items-center gap-1">
                  <span className="list-color-dot" data-color={chip.color} aria-hidden="true" />
                  {chip.name}
                </span>
              </span>
            ))}
            {when ? <><MetaSep /><time dateTime={proposal.createdAt}>{when}</time></> : null}
          </p>
        </div>
      </div>
      {editing ? <div className="rounded-lg border px-3 py-2 text-sm" style={{ borderColor: 'color-mix(in srgb, #4772FA 40%, transparent)', background: 'color-mix(in srgb, #4772FA 12%, transparent)' }}>{t('edit.banner')}</div> : null}
      {impact ? <p className="text-sm text-muted-foreground">{impact}</p> : null}
      {note ? <p className="rounded-lg border border-[var(--warning-border)] bg-[var(--warning-bg)] px-3 py-2 text-sm text-foreground">{note}</p> : null}
      {error ? (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm">
          <span>{error.message}</span>
          {error.conflict ? <Button type="button" size="sm" variant="outline" onClick={onRefresh}>{t('error.refresh')}</Button> : null}
        </div>
      ) : null}
      {children}
      {footer}
      <Collapsible>
        <CollapsibleTrigger className="cursor-pointer text-sm text-muted-foreground">{t('tech.title')}</CollapsibleTrigger>
        <CollapsibleContent className="mt-2 space-y-1 text-xs text-muted-foreground">
          <p>{t('tech.actorId')}: {proposal.actorId}</p>
          <p className="break-all">{t('tech.proposalId')}: {proposal.id}</p>
          <p>{t('tech.revision')}: {proposal.revision}</p>
          {targetIds.length ? <p className="break-all">{t('tech.targetId')}: {targetIds.join(', ')}</p> : null}
          {rawPreview ? <div><div>{t('tech.preview')}</div><pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-[var(--glass-control)] p-3">{rawPreview}</pre></div> : null}
        </CollapsibleContent>
      </Collapsible>
    </article>
  );
}
