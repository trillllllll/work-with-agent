import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { useRecordFocusSession } from '@/hooks/useTodo.js';
import { beep, focusReducer, formatClock, loadFocusState, notify, phaseLabel, remainingMs, saveFocusState, type FocusAction, type FocusEffect, type FocusState } from '@/lib/focus.js';

type FocusContextValue = {
  state: FocusState;
  now: number;
  dispatch: (action: FocusAction) => void;
  remainingLabel: string;
};

const FocusContext = createContext<FocusContextValue | null>(null);

export function useFocus() {
  const value = useContext(FocusContext);
  if (!value) throw new Error('专注计时尚未就绪');
  return value;
}

export function FocusProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<FocusState>(loadFocusState);
  const [now, setNow] = useState(() => Date.now());
  const pending = useRef<FocusEffect[]>([]);
  const record = useRecordFocusSession();
  const recordRef = useRef(record);
  recordRef.current = record;
  const baseTitle = useRef(typeof document === 'undefined' ? '工作区' : document.title);

  const dispatch = (action: FocusAction) => {
    setState((current) => {
      const next = focusReducer(current, action);
      if (next.effects.length) pending.current.push(...next.effects);
      return next.state === current ? current : next.state;
    });
  };

  useEffect(() => { saveFocusState(state); }, [state]);
  useEffect(() => {
    const batch = pending.current.splice(0);
    for (const effect of batch) {
      if (effect.type === 'FOCUS_COMPLETED') {
        recordRef.current.mutate({ taskId: effect.taskId, kind: 'focus', startedAt: effect.startedAt, endedAt: effect.endedAt, durationMinutes: effect.durationMinutes, plannedMinutes: effect.plannedMinutes, completed: effect.completed });
        toast.success('专注完成，休息一下');
        beep();
        notify('专注完成，休息一下');
      } else {
        toast.success('休息结束');
        beep();
      }
    }
  });
  useEffect(() => {
    const tick = () => {
      const next = Date.now();
      setNow(next);
      dispatch({ type: 'TICK', now: next });
    };
    const timer = window.setInterval(tick, 1000);
    const onVisible = () => { if (document.visibilityState === 'visible') tick(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, []);
  useEffect(() => {
    if (state.phase === 'idle') {
      document.title = baseTitle.current || '工作区';
      return;
    }
    const label = state.phase === 'focusing' || state.phase === 'focusPaused' ? '专注中' : '休息中';
    document.title = `${formatClock(remainingMs(state, now))} · ${label}`;
  }, [state, now]);
  useEffect(() => () => { document.title = baseTitle.current || '工作区'; }, []);

  return <FocusContext.Provider value={{ state, now, dispatch, remainingLabel: formatClock(remainingMs(state, now)) }}>{children}</FocusContext.Provider>;
}

export function focusPhaseText(state: FocusState) {
  return phaseLabel(state.phase);
}
