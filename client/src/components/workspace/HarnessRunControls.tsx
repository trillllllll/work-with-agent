import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, CircleGauge, Ellipsis, GitBranch, ListOrdered, Pencil, Play, RotateCcw, X } from 'lucide-react';
import { MarkdownView } from '@/components/shared/MarkdownView.js';
import { Button } from '@/components/ui/button.js';
import { ChoiceList } from '@/components/ui/choice-list.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.js';
import { Surface } from '@/components/ui/surface.js';
import { Textarea } from '@/components/ui/textarea.js';
import { HARNESS_TEXT_LIMIT, type HarnessApproval, type HarnessCommand, type HarnessQueue, type HarnessTurn, type HarnessView } from '../../../../server/src/node-agent/harness-protocol.js';

type Intent<C = HarnessCommand> = C extends HarnessCommand ? Omit<C, 'commandId' | 'expectedEpoch'> : never;
export type HarnessAction = Intent;

export function HarnessTurnControls({ turn, prompt, disabled, canRerun, settingsRevision, act }: {
  turn: HarnessTurn; prompt?: string; disabled: boolean; canRerun: boolean; settingsRevision?: number;
  act: (action: HarnessAction) => void;
}) {
  const { t } = useTranslation('workspace');
  const [edit, setEdit] = useState<string | null>(null);
  const [retry, setRetry] = useState(false);
  const rerun = (text?: string) => act({ operation: 'rerun', turnId: turn.id,
    ...(text ? { text } : {}), ...(settingsRevision === undefined ? {} : { expectedSettingsRevision: settingsRevision }),
  });
  return <div className="flex justify-end">
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button type="button" variant="ghost" size="icon" aria-label={t('harness.turnActions')} disabled={disabled}><Ellipsis /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => act({ operation: 'fork', turnId: turn.id })}><GitBranch />{t('harness.fork')}</DropdownMenuItem>
        {canRerun && prompt && <DropdownMenuItem onSelect={() => setEdit(prompt)}><Pencil />{t('harness.editRerun')}</DropdownMenuItem>}
        {canRerun && turn.status === 'failed' && <DropdownMenuItem onSelect={() => setRetry(true)}><RotateCcw />{t('harness.rerun')}</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
    <Dialog open={edit !== null || retry} onOpenChange={(next) => { if (!next) { setEdit(null); setRetry(false); } }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(edit === null ? 'harness.rerun' : 'harness.editRerun')}</DialogTitle>
          <DialogDescription>{t('harness.rerunHint')}</DialogDescription>
        </DialogHeader>
        <form className="grid gap-3" onSubmit={(event) => {
          event.preventDefault();
          rerun(edit?.trim());
          setEdit(null);
          setRetry(false);
        }}>
          {edit !== null && <Textarea value={edit} onChange={(event) => setEdit(event.target.value)} maxLength={HARNESS_TEXT_LIMIT} aria-label={t('harness.editRerun')} />}
          <DialogFooter><Button type="submit" disabled={disabled || !canRerun || edit !== null && !edit.trim()}>{t('harness.rerun')}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </div>;
}

export function HarnessQuestion({ request, disabled, answer }: {
  request: HarnessApproval; disabled: boolean; answer: (action: HarnessAction) => void;
}) {
  const { t } = useTranslation('workspace');
  const [values, setValues] = useState<Record<string, string>>({});
  const questions = request.questions ?? [];
  const set = (id: string, value: string) => setValues((previous) => ({ ...previous, [id]: value }));
  return <Surface tone="subtle" className="grid gap-3 rounded-xl p-3">
    <form className="grid gap-3" onSubmit={(event) => {
      event.preventDefault();
      answer({ operation: 'answerQuestion', requestId: request.id, answers: questions.map(({ id }) => ({ id, value: values[id].trim() })) });
    }}>
      {questions.map((question) => <div key={question.id} className="grid gap-2">
        {question.options.length > 0 ? <ChoiceList label={question.label} value={values[question.id] ?? ''}
          options={question.options.map((option) => ({ ...option, id: option.label }))} disabled={disabled}
          onChange={(value) => set(question.id, value)} /> : <p className="text-sm font-medium">{question.label}</p>}
        {question.freeText && <Textarea aria-label={t('harness.answer')} maxLength={2_000} disabled={disabled}
          value={values[question.id] ?? ''} onChange={(event) => set(question.id, event.target.value)} />}
      </div>)}
      <Button type="submit" className="min-h-11 justify-self-end" disabled={disabled || !questions.every((question) => values[question.id]?.trim())}>
        {t('harness.submitAnswers')}
      </Button>
    </form>
  </Surface>;
}

export function HarnessQueueControls({ queue, running, disabled, act }: {
  queue: HarnessQueue; running: boolean; disabled: boolean; act: (action: HarnessAction) => void;
}) {
  const { t } = useTranslation('workspace');
  const [edit, setEdit] = useState<{ id: string; revision: number; text: string } | null>(null);
  if (!queue.items.length && !edit) return null;
  return <Surface tone="subtle" className="mx-2 mb-2 grid max-h-44 gap-1 overflow-y-auto rounded-lg px-2">
    {queue.items.length > 0 && <p className="flex items-center gap-1.5 pt-2 text-xs font-medium text-muted-foreground">
      <ListOrdered className="size-3.5" />{t('harness.queue.title', { count: queue.items.length })}
    </p>}
    {queue.items.map((item, index) => {
      const target = { itemId: item.id, expectedQueueRevision: queue.revision };
      return <div key={item.id} className="flex min-w-0 items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm" title={item.text}>{item.text}</p>
          <p className="truncate text-xs text-muted-foreground">{item.error || (item.status === 'starting' ? t('harness.queue.starting') : item.settings?.model)}</p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button size="sm" variant="ghost" type="button" className="min-h-11" disabled={disabled || item.status === 'starting'}>{t('harness.queue.actions')}</Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={item.status !== 'queued'} onSelect={() => act({ operation: 'sendQueuedNow', ...target })}>
              <Play />{t(running ? 'harness.queue.sendNowInterrupt' : 'harness.queue.sendNow')}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={item.status !== 'queued'} onSelect={() => setEdit({ id: item.id, revision: queue.revision, text: item.text })}>
              <Pencil />{t('harness.queue.edit')}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!index || item.status !== 'queued'} onSelect={() => act({ operation: 'moveQueued', ...target, direction: 'up' })}><ArrowUp />{t('harness.queue.up')}</DropdownMenuItem>
            <DropdownMenuItem disabled={index === queue.items.length - 1 || item.status !== 'queued'} onSelect={() => act({ operation: 'moveQueued', ...target, direction: 'down' })}><ArrowDown />{t('harness.queue.down')}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => act({ operation: 'removeQueued', ...target })}><X />{t('harness.queue.remove')}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>;
    })}
    <Dialog open={!!edit} onOpenChange={(next) => { if (!next) setEdit(null); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('harness.queue.edit')}</DialogTitle></DialogHeader>
        {edit && <form className="grid gap-3" onSubmit={(event) => {
          event.preventDefault();
          act({ operation: 'editQueued', itemId: edit.id, expectedQueueRevision: edit.revision, text: edit.text.trim() });
          setEdit(null);
        }}>
          <Textarea aria-label={t('harness.queue.edit')} value={edit.text} onChange={(event) => setEdit({ ...edit, text: event.target.value })} maxLength={HARNESS_TEXT_LIMIT} />
          {edit.revision !== queue.revision && <p role="status" className="text-sm text-muted-foreground">{t('harness.queue.changed')}</p>}
          <DialogFooter><Button type="submit" disabled={disabled || !edit.text.trim() || edit.revision !== queue.revision}>{t('settings:actions.save')}</Button></DialogFooter>
        </form>}
      </DialogContent>
    </Dialog>
  </Surface>;
}

export function HarnessPlan({ plan, canApprove, approve }: {
  plan: NonNullable<HarnessView['plan']>; canApprove: boolean; approve: () => void;
}) {
  const { t } = useTranslation('workspace');
  return <Surface tone="subtle" className="grid gap-2 rounded-xl p-3">
    <h3 className="text-sm font-medium">{t('harness.plan.title')}</h3>
    {plan.text && <MarkdownView content={plan.text} responsiveTables />}
    {plan.steps.length > 0 && <ul className="space-y-1 text-sm">
      {plan.steps.map((step, index) => <li key={index} className="flex gap-2">
        <span className="shrink-0 text-xs text-muted-foreground">{t('harness.plan.' + step.status)}</span>{step.text}
      </li>)}
    </ul>}
    {canApprove && <Button type="button" className="min-h-11 justify-self-end" onClick={approve}>{t('harness.plan.approve')}</Button>}
  </Surface>;
}

export function HarnessContext({ usage, disabled, compact }: {
  usage?: HarnessView['usage']; disabled: boolean; compact: () => void;
}) {
  const { t } = useTranslation('workspace');
  return <DropdownMenu>
    <DropdownMenuTrigger asChild><Button size="icon" variant="ghost" type="button" className="min-h-11" aria-label={t('harness.context.title')}><CircleGauge /></Button></DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      <DropdownMenuLabel>{usage
        ? t(usage.limit ? 'harness.context.usedWithLimit' : 'harness.context.used', { used: usage.used.toLocaleString(), limit: usage.limit?.toLocaleString() })
        : t('harness.context.usageUnavailable')}</DropdownMenuLabel>
      <DropdownMenuItem disabled={disabled} onSelect={compact}>{t('harness.context.compact')}</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}
