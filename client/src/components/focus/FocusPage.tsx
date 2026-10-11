import { Pause, Play, SkipForward, Square } from 'lucide-react';
import { useLocalDate, useFocusSessions, useTasks } from '@/hooks/useTodo.js';
import { addDays, formatTime, mondayOf } from '@/lib/schedule.js';
import { elapsedRatio, phaseLabel } from '@/lib/focus.js';
import { Button } from '@/components/ui/button.js';
import { cn } from '@/lib/utils.js';
import { useFocus } from './FocusProvider.js';

const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

export function FocusPage() {
  const { state, now, dispatch, remainingLabel } = useFocus();
  const today = useLocalDate();
  const start = mondayOf(today);
  const days = Array.from({ length: 7 }, (_, index) => addDays(start, index));
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
    <h1 className="text-2xl font-semibold">专注</h1>
    <section className="glass-subtle flex flex-col items-center gap-6 rounded-2xl p-8">
      <div className="relative grid size-[240px] place-items-center">
        <svg width="240" height="240" viewBox="0 0 240 240" aria-hidden="true">
          <circle cx="120" cy="120" r={radius} fill="none" stroke="var(--glass-hover)" strokeWidth="12" />
          <circle cx="120" cy="120" r={radius} fill="none" stroke={resting ? 'var(--success)' : 'var(--primary)'} strokeWidth="12" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - progress)} transform="rotate(-90 120 120)" />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <p data-testid="focus-remaining" className="text-[40px] font-semibold tabular-nums">{remainingLabel}</p>
          <p className="text-sm text-muted-foreground">{phaseLabel(state.phase)}</p>
          <p className="max-w-[320px] truncate text-[13px]">{state.taskTitle || '自由专注'}</p>
        </div>
      </div>
      <div className="flex items-center gap-3">
        {state.phase === 'idle' && <Button type="button" className="size-11 rounded-full" aria-label="开始专注" onClick={() => { askNotification(); dispatch({ type: 'START', taskId: state.taskId, taskTitle: state.taskTitle, now: Date.now() }); }}><Play className="size-5" strokeWidth={1.75} /></Button>}
        {state.phase === 'focusing' && <Button type="button" className="size-11 rounded-full" aria-label="暂停" onClick={() => dispatch({ type: 'PAUSE', now: Date.now() })}><Pause className="size-5" strokeWidth={1.75} /></Button>}
        {state.phase === 'focusPaused' && <Button type="button" className="size-11 rounded-full" aria-label="继续专注" onClick={() => dispatch({ type: 'RESUME', now: Date.now() })}><Play className="size-5" strokeWidth={1.75} /></Button>}
        {state.phase === 'breakReady' && <Button type="button" className="size-11 rounded-full" aria-label="开始休息" onClick={() => dispatch({ type: 'RESUME', now: Date.now() })}><Play className="size-5" strokeWidth={1.75} /></Button>}
        {(state.phase === 'breaking') && <Button type="button" className="size-11 rounded-full" aria-label="暂停休息" onClick={() => dispatch({ type: 'PAUSE', now: Date.now() })}><Pause className="size-5" strokeWidth={1.75} /></Button>}
        {state.phase === 'breakPaused' && <Button type="button" className="size-11 rounded-full" aria-label="继续休息" onClick={() => dispatch({ type: 'RESUME', now: Date.now() })}><Play className="size-5" strokeWidth={1.75} /></Button>}
        {(state.phase === 'focusing' || state.phase === 'focusPaused') && <Button type="button" variant="secondary" onClick={() => dispatch({ type: 'STOP_EARLY', now: Date.now() })}><Square className="size-4" strokeWidth={1.75} />结束并记录</Button>}
        {(state.phase === 'breaking' || state.phase === 'breakPaused' || state.phase === 'breakReady') && <Button type="button" variant="secondary" onClick={() => dispatch({ type: 'SKIP_BREAK' })}><SkipForward className="size-4" strokeWidth={1.75} />跳过休息</Button>}
      </div>
    </section>
    <section className="glass-control flex flex-wrap items-center gap-4 rounded-xl p-4 text-sm">
      <label className="flex items-center gap-2">专注时长<input type="number" min={5} max={120} className="glass-subtle w-20 rounded-lg px-2 py-1" aria-label="专注时长" disabled={state.phase !== 'idle'} value={state.plannedMinutes} onChange={(event) => dispatch({ type: 'SET_DURATIONS', plannedMinutes: Number(event.target.value), breakMinutes: state.breakMinutes })} />分钟</label>
      <label className="flex items-center gap-2">休息时长<input type="number" min={1} max={30} className="glass-subtle w-20 rounded-lg px-2 py-1" aria-label="休息时长" disabled={state.phase !== 'idle'} value={state.breakMinutes} onChange={(event) => dispatch({ type: 'SET_DURATIONS', plannedMinutes: state.plannedMinutes, breakMinutes: Number(event.target.value) })} />分钟</label>
      <label className="flex items-center gap-2"><input type="checkbox" className="accent-[var(--primary)]" checked={state.autoStartBreak} disabled={state.phase !== 'idle'} onChange={(event) => dispatch({ type: 'SET_DURATIONS', plannedMinutes: state.plannedMinutes, breakMinutes: state.breakMinutes, autoStartBreak: event.target.checked })} />自动开始休息</label>
    </section>
    <section className="grid grid-cols-2 gap-4">
      <article className="glass-subtle rounded-xl p-4">
        <p className="text-xs text-muted-foreground">今日专注</p>
        <p className="text-2xl font-semibold tabular-nums">{todayMinutes}</p>
        <p className="text-xs text-muted-foreground">{todayCount} 个番茄</p>
      </article>
      <article className="glass-subtle rounded-xl p-4">
        <p className="text-xs text-muted-foreground">近 7 天</p>
        <div className="mt-2 flex h-16 items-end gap-1.5">
          {minutes.map((value, index) => <span key={days[index]} className={cn('flex-1 rounded-sm', value ? days[index] === today ? 'bg-[var(--primary)]' : 'bg-[var(--primary)]/80' : 'h-1 bg-[var(--glass-hover)]')} style={value ? { height: `${Math.max(4, Math.round(value / peak * 64))}px` } : undefined} />)}
        </div>
        <div className="mt-1 flex gap-1.5">
          {weekdays.map((label) => <span key={label} className="flex-1 text-center text-[10px] text-muted-foreground">{label}</span>)}
        </div>
      </article>
    </section>
    <section className="glass-subtle divide-y divide-[var(--glass-divider)] rounded-2xl">
      {sessions.isLoading && <p className="px-4 py-8 text-center text-sm text-muted-foreground">正在加载任务…</p>}
      {sessions.error && <p role="alert" className="px-4 py-8 text-center text-sm text-destructive">{sessions.error.message}</p>}
      {!sessions.isLoading && !sessions.error && !rows.length && <p className="px-4 py-8 text-center text-sm text-muted-foreground">暂无任务</p>}
      {rows.map((session) => <div key={session.id} className="flex h-12 items-center gap-3 px-4 text-sm">
        <span className={cn('min-w-0 flex-1 truncate', !session.taskId && 'text-muted-foreground')}>{session.kind === 'break' ? '休息' : session.taskId ? titles.get(session.taskId) ?? '自由专注' : '自由专注'}</span>
        <time className="tabular-nums text-muted-foreground">{formatTime(session.startedAt)}-{formatTime(session.endedAt)}</time>
        <span className="shrink-0">{session.durationMinutes} 分钟{!session.completed && <span className="ml-2 text-xs text-[var(--warning)]">已中断</span>}</span>
      </div>)}
    </section>
  </div>;
}
