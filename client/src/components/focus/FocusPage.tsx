import { useTranslation } from 'react-i18next';
import { usePageContext } from '@/lib/assistant-context.js';
import { Pause, Play, SkipForward, Square } from 'lucide-react';
import { useLocalDate, useFocusSessions, useTasks } from '@/hooks/useTodo.js';
import { addDays, formatTime, mondayOf } from '@/lib/schedule.js';
import { elapsedRatio, phaseLabel } from '@/lib/focus.js';
import { Button } from '@/components/ui/button.js';
import { cn } from '@/lib/utils.js';
import { useFocus } from './FocusProvider.js';

const weekdayIds = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

export function FocusPage() {
  const { t } = useTranslation('plan');
  const { state, now, dispatch, remainingLabel } = useFocus();
  const today = useLocalDate();
  const start = mondayOf(today);
  const days = Array.from({ length: 7 }, (_, index) => addDays(start, index));
  usePageContext('focus', { pageState: { selectedId: state.taskId ?? '', status: state.phase, dateFrom: days[0], dateTo: days[6] } });
  const sessions = useFocusSessions({ from: days[0], to: days[6] });
  const tasks = useTasks({ status: 'all' });
  const titles = new Map((tasks.data ?? []).map((task) => [task.id, task.title]));
  const rows = sessions.data ?? [];
  const todayFocus = rows.filter((session) => session.kind === 'focus' && session.startedAt.startsWith(today));
  const todayMinutes = todayFocus.reduce((sum, session) => sum + session.durationMinutes, 0);
  const todayCount = todayFocus.filter((session) => session.completed).length;
  const minutes = days.map((day) => rows.filter((session) => session.kind === 'focus' && session.startedAt.startsWith(day)).reduce((sum, session) => sum + session.durationMinutes, 0));
  const peak = Math.max(...minutes);
  const resting = state.phase === 'breaking' || state.phase === 'breakPaused' || state.phase === 'breakReady';
  const progress = elapsedRatio(state, now);
  const radius = 104;
  const circumference = 2 * Math.PI * radius;
  const askNotification = () => { if (typeof Notification !== 'undefined' && Notification.permission === 'default') void Notification.requestPermission(); };

  return <div data-testid="focus-page" className="mx-auto max-w-5xl space-y-6 p-5 sm:p-7">
    <h1 className="text-2xl font-semibold">{t('focus.title')}</h1>
    <section className="glass-subtle flex flex-col items-center gap-6 rounded-2xl p-8">
      <div className="relative grid size-[240px] place-items-center">
        <svg width="240" height="240" viewBox="0 0 240 240" aria-hidden="true">
          <circle cx="120" cy="120" r={radius} fill="none" stroke="var(--glass-hover)" strokeWidth="12" />
          <circle cx="120" cy="120" r={radius} fill="none" stroke={resting ? 'var(--success)' : 'var(--primary)'} strokeWidth="12" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - progress)} transform="rotate(-90 120 120)" />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <p data-testid="focus-remaining" className="text-[40px] font-semibold tabular-nums">{remainingLabel}</p>
          <p className="text-sm text-muted-foreground">{phaseLabel(state.phase)}</p>
          <p className="max-w-[320px] truncate text-[13px]">{state.taskTitle || t('focus.free')}</p>
        </div>
      </div>
      <div className="flex items-center gap-3">
        {state.phase === 'idle' && <Button type="button" className="size-11 rounded-full" aria-label={t('focus.start')} onClick={() => { askNotification(); dispatch({ type: 'START', taskId: state.taskId, taskTitle: state.taskTitle, now: Date.now() }); }}><Play className="size-5" strokeWidth={1.75} /></Button>}
        {state.phase === 'focusing' && <Button type="button" className="size-11 rounded-full" aria-label={t('focus.pause')} onClick={() => dispatch({ type: 'PAUSE', now: Date.now() })}><Pause className="size-5" strokeWidth={1.75} /></Button>}
        {state.phase === 'focusPaused' && <Button type="button" className="size-11 rounded-full" aria-label={t('focus.resumeFocus')} onClick={() => dispatch({ type: 'RESUME', now: Date.now() })}><Play className="size-5" strokeWidth={1.75} /></Button>}
        {state.phase === 'breakReady' && <Button type="button" className="size-11 rounded-full" aria-label={t('focus.startBreak')} onClick={() => dispatch({ type: 'RESUME', now: Date.now() })}><Play className="size-5" strokeWidth={1.75} /></Button>}
        {(state.phase === 'breaking') && <Button type="button" className="size-11 rounded-full" aria-label={t('focus.pauseBreak')} onClick={() => dispatch({ type: 'PAUSE', now: Date.now() })}><Pause className="size-5" strokeWidth={1.75} /></Button>}
        {state.phase === 'breakPaused' && <Button type="button" className="size-11 rounded-full" aria-label={t('focus.resumeBreak')} onClick={() => dispatch({ type: 'RESUME', now: Date.now() })}><Play className="size-5" strokeWidth={1.75} /></Button>}
        {(state.phase === 'focusing' || state.phase === 'focusPaused') && <Button type="button" variant="secondary" onClick={() => dispatch({ type: 'STOP_EARLY', now: Date.now() })}><Square className="size-4" strokeWidth={1.75} />{t('focus.endAndLog')}</Button>}
        {(state.phase === 'breaking' || state.phase === 'breakPaused' || state.phase === 'breakReady') && <Button type="button" variant="secondary" onClick={() => dispatch({ type: 'SKIP_BREAK' })}><SkipForward className="size-4" strokeWidth={1.75} />{t('focus.skipBreak')}</Button>}
      </div>
    </section>
    <section className="glass-control flex flex-wrap items-center gap-4 rounded-xl p-4 text-sm">
      <label className="flex items-center gap-2">{t('focus.focusDuration')}<input type="number" min={5} max={120} className="glass-subtle w-20 rounded-lg px-2 py-1" aria-label={t('focus.focusDuration')} disabled={state.phase !== 'idle'} value={state.plannedMinutes} onChange={(event) => dispatch({ type: 'SET_DURATIONS', plannedMinutes: Number(event.target.value), breakMinutes: state.breakMinutes })} />{t('focus.minuteUnit')}</label>
      <label className="flex items-center gap-2">{t('focus.breakDuration')}<input type="number" min={1} max={30} className="glass-subtle w-20 rounded-lg px-2 py-1" aria-label={t('focus.breakDuration')} disabled={state.phase !== 'idle'} value={state.breakMinutes} onChange={(event) => dispatch({ type: 'SET_DURATIONS', plannedMinutes: state.plannedMinutes, breakMinutes: Number(event.target.value) })} />{t('focus.minuteUnit')}</label>
      <label className="flex items-center gap-2"><input type="checkbox" className="accent-[var(--primary)]" checked={state.autoStartBreak} disabled={state.phase !== 'idle'} onChange={(event) => dispatch({ type: 'SET_DURATIONS', plannedMinutes: state.plannedMinutes, breakMinutes: state.breakMinutes, autoStartBreak: event.target.checked })} />{t('focus.autoStartBreak')}</label>
    </section>
    <section className="grid grid-cols-2 gap-4">
      <article className="glass-subtle rounded-xl p-4">
        <p className="text-xs text-muted-foreground">{t('focus.today')}</p>
        <p className="text-2xl font-semibold tabular-nums">{todayMinutes}</p>
        <p className="text-xs text-muted-foreground">{t('focus.pomodoros', { count: todayCount })}</p>
      </article>
      <article className="glass-subtle rounded-xl p-4">
        <p className="text-xs text-muted-foreground">{t('focus.last7Days')}</p>
        <div className="mt-2 flex h-16 items-end gap-1.5">
          {minutes.map((value, index) => <span key={days[index]} className={cn('flex-1 rounded-sm', value ? days[index] === today ? 'bg-[var(--primary)]' : 'bg-[var(--primary)]/80' : 'h-1 bg-[var(--glass-hover)]')} style={value ? { height: `${Math.max(4, Math.round(value / peak * 64))}px` } : undefined} />)}
        </div>
        <div className="mt-1 flex gap-1.5">
          {weekdayIds.map((day) => <span key={day} className="flex-1 text-center text-[10px] text-muted-foreground">{t(`weekday.${day}.short`)}</span>)}
        </div>
      </article>
    </section>
    <section className="glass-subtle divide-y divide-[var(--glass-divider)] rounded-2xl">
      {sessions.isLoading && <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t('shared.loadingTasks')}</p>}
      {sessions.error && <p role="alert" className="px-4 py-8 text-center text-sm text-destructive">{sessions.error.message}</p>}
      {!sessions.isLoading && !sessions.error && !rows.length && <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t('focus.empty')}</p>}
      {rows.map((session) => <div key={session.id} className="flex h-12 items-center gap-3 px-4 text-sm">
        <span className={cn('min-w-0 flex-1 truncate', !session.taskId && 'text-muted-foreground')}>{session.kind === 'break' ? t('focus.break') : session.taskId ? titles.get(session.taskId) ?? t('focus.free') : t('focus.free')}</span>
        <time className="tabular-nums text-muted-foreground">{formatTime(session.startedAt)}-{formatTime(session.endedAt)}</time>
        <span className="shrink-0">{t('focus.sessionMinutes', { count: session.durationMinutes })}{!session.completed && <span className="ml-2 text-xs text-[var(--warning)]">{t('focus.interrupted')}</span>}</span>
      </div>)}
    </section>
  </div>;
}
