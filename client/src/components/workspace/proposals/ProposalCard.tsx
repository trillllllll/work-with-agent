import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api.js';
import { json } from '@/lib/platform.js';
import { analyzeProposal, itemMark, type ProposalCommand } from '@/lib/proposal-group.js';
import { isEditableField } from '@/lib/proposal-fields.js';
import type { ConnectionName } from '@/lib/proposal-source.js';
import { Button } from '@/components/ui/button.js';
import { GroupTree } from './GroupTree.js';
import { MemoryBody } from './MemoryBody.js';
import { SkillBody } from './SkillBody.js';
import { TaskDiff } from './TaskDiff.js';
import { EvidenceList } from './EvidenceList.js';
import { CommandFields } from './EditFields.js';
import { RejectPanel } from './RejectPanel.js';
import { ProposalFrame } from './ProposalFrame.js';
import { cardDataState, cloneCommands, describeError, invalidateProposalViews, rejectedReason, sameCommands, type TopicRef } from './present.js';
import type { Proposal } from './types.js';

export function ProposalCard({ proposal, connections, topics, selected, onSelected, externalError, onClearError, actionsLocked }: {
  proposal: Proposal;
  connections?: ConnectionName[];
  topics?: TopicRef[];
  selected: boolean;
  onSelected: (selected: boolean) => void;
  externalError?: unknown;
  onClearError: () => void;
  actionsLocked: boolean;
}) {
  const { t } = useTranslation('proposals');
  const client = useQueryClient();
  const [baseline] = useState(() => cloneCommands(proposal.commands));
  const [draft, setDraft] = useState(() => cloneCommands(proposal.commands));
  const [mode, setMode] = useState<'view' | 'edit' | 'reject'>('view');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<unknown>(null);
  const pending = proposal.status === 'pending';
  const shown = externalError ?? localError;
  const described = shown ? describeError(shown) : null;
  const conflict = described?.conflict ?? false;
  const commands = mode === 'edit' ? draft : baseline;
  const analysis = analyzeProposal(commands, proposal.preview);
  const reason = rejectedReason(proposal);
  const locked = busy || actionsLocked;
  const dirty = !sameCommands(draft, baseline);
  const canEdit = analysis.items.some((item) => Object.keys(item.command.input ?? {}).some((key) => isEditableField(item.kind, key)));
  const state = cardDataState(proposal.status, mode, Boolean(described));

  const change = (index: number, key: string, value: unknown) => {
    setDraft((all) => all.map((command, at) => at === index ? { ...command, input: { ...command.input, [key]: value } } : command));
  };
  const run = async (work: () => Promise<unknown>) => {
    if (locked) return;
    setBusy(true);
    setLocalError(null);
    try {
      await work();
      onClearError();
      await invalidateProposalViews(client);
      return true;
    } catch (error) {
      setLocalError(error);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const refresh = async () => {
    setBusy(true);
    setLocalError(null);
    onClearError();
    try { await invalidateProposalViews(client); } finally { setBusy(false); }
  };
  const single = analysis.items.length === 1 ? analysis.items[0] : null;
  const body = !single ? <GroupTree analysis={analysis} editing={mode === 'edit'} onChange={change} />
    : single.kind.startsWith('memory.') ? <MemoryBody item={single} editing={mode === 'edit'} onChange={(key, value) => change(0, key, value)} />
    : single.kind.startsWith('skill.') ? <SkillBody item={single} editing={mode === 'edit'} onChange={(key, value) => change(0, key, value)} />
    : single.kind === 'task.update' || single.kind === 'task.delete' || single.kind === 'task.restore' || single.kind === 'task.permanent_delete'
      ? <TaskDiff item={single} editing={mode === 'edit'} onChange={(key, value) => change(0, key, value)} />
      : <CommandFields item={single} editing={mode === 'edit'} onChange={(key, value) => change(0, key, value)} />;
  const evidence = analysis.items.map((item) => (
    <EvidenceList key={item.index} detail={item.detail} fallbackEvidence={item.command.evidence ?? item.command.input?.evidence} mark={analysis.items.length > 1 ? itemMark(item.index) : undefined} />
  ));
  const footer = !pending || mode === 'reject' ? mode === 'reject' && pending ? (
    <RejectPanel busy={locked} conflict={conflict} onCancel={() => { setMode('view'); setLocalError(null); }} onConfirm={(text) => { void run(async () => { await api(`/api/v1/proposals/${proposal.id}/reject`, { method: 'POST', body: json({ expectedRevision: proposal.revision, reason: text }) }); }); }} />
  ) : null : mode === 'edit' ? (
    <div className="flex flex-wrap justify-end gap-2">
      <Button type="button" variant="ghost" disabled={locked} onClick={() => { setDraft(cloneCommands(baseline)); setMode('view'); setLocalError(null); }}>{t('edit.cancel')}</Button>
      <Button type="button" disabled={locked || conflict || !dirty} onClick={() => { void run(async () => { await api(`/api/v1/proposals/${proposal.id}`, { method: 'PATCH', body: json({ expectedRevision: proposal.revision, commands: draft satisfies ProposalCommand[] }) }); setMode('view'); }); }}>{t('edit.save')}</Button>
    </div>
  ) : (
    <div className="flex flex-wrap justify-end gap-2">
      <Button type="button" variant="ghost" disabled={locked || conflict} onClick={() => { setMode('reject'); setLocalError(null); }}>{t('reject.start')}</Button>
      {canEdit ? <Button type="button" variant="outline" disabled={locked || conflict} onClick={() => { setMode('edit'); setLocalError(null); }}>{t('edit.start')}</Button> : null}
      <Button type="button" disabled={locked || conflict} onClick={() => { void run(() => api(`/api/v1/proposals/${proposal.id}/approve`, { method: 'POST', body: json({ expectedRevision: proposal.revision, requestId: crypto.randomUUID() }) })); }}>{analysis.confirmLabel}</Button>
    </div>
  );

  return (
    <ProposalFrame proposal={proposal} analysis={analysis} connections={connections} topics={topics} state={state} selectable={pending} selected={selected} onSelected={onSelected} selectionLocked={actionsLocked} editing={pending && mode === 'edit'} error={described} onRefresh={() => { void refresh(); }} footer={footer}>
      {reason ? <p className="text-sm">{t('reject.reason', { reason })}</p> : null}
      {body}
      {evidence}
    </ProposalFrame>
  );
}
