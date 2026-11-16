import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useRecordFocusSession } from '@/hooks/useTodo.js';
import { isEditorRuntimeActive, useEditorRuntime } from '@/lib/task-editor-runtime.js';
import { listLearningRecords, readLearningRecord, removeLearningRecord, writeLearningRecord } from '@/lib/learning-storage.js';
import { beep, focusReducer, formatClock, loadFocusState, notify, phaseLabel, remainingMs, saveFocusState, type FocusAction, type FocusEffect, type FocusState } from '@/lib/focus.js';
import { focusRecordKind, hasSavedFocusRecord, withFocusRecordLock, type FocusSessionInput } from '@/lib/focus-records.js';
import { queryKeys } from '@/lib/todo.js';

type FocusContextValue = {
  state: FocusState;
  now: number;
  dispatch: (action: FocusAction) => void;
  remainingLabel: string;
};

const FocusContext = createContext<FocusContextValue | null>(null);

export function useFocus() {
  const { t } = useTranslation('plan');
  const value = useContext(FocusContext);
  if (!value) throw new Error(t('focus.notReady'));
  return value;
}

export function FocusProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation('plan');
  const client = useQueryClient();
  const scope = useEditorRuntime()?.scopeKey;
  const [state, setState] = useState<FocusState>(loadFocusState);
  const [now, setNow] = useState(() => Date.now());
  const pending = useRef<FocusEffect[]>([]);
  const { mutateAsync } = useRecordFocusSession();
  const recordRef = useRef(mutateAsync);
  recordRef.current = mutateAsync;
  const baseTitle = useRef(typeof document === 'undefined' ? t('focus.workspace') : document.title);

  const dispatch = (action: FocusAction) => {
    setState((current) => {
      const next = focusReducer(current, action);
      if (next.effects.length) pending.current.push(...next.effects);
      return next.state === current ? current : next.state;
    });
  };

  const recordSession = async (input: FocusSessionInput) => {
    let stored = false;
    try {
      if (!scope) {
        await recordRef.current(input);
        return;
      }
      const id = crypto.randomUUID();
      await withFocusRecordLock(scope, id, async () => {
        stored = await writeLearningRecord(scope, focusRecordKind, id, input).then(() => true, () => false);
        if (!isEditorRuntimeActive(scope)) return;
        await recordRef.current(input);
        if (stored) await removeLearningRecord(scope, focusRecordKind, id, input).catch(() => undefined);
      });
    } catch {
      toast.error(t(stored ? 'focus.recordFailed' : 'focus.recordNotRetained'));
    }
  };
  useEffect(() => { saveFocusState(state); }, [state]);
  useEffect(() => {
    const batch = pending.current.splice(0);
    for (const effect of batch) {
      if (effect.type === 'FOCUS_COMPLETED') {
        void recordSession({ taskId: effect.taskId, kind: 'focus', startedAt: effect.startedAt, endedAt: effect.endedAt, durationMinutes: effect.durationMinutes, plannedMinutes: effect.plannedMinutes, completed: effect.completed });
        toast.success(t('focus.completedToast'));
        beep();
        notify(t('focus.completedToast'));
      } else {
        toast.success(t('focus.breakOver'));
        beep();
      }
    }
  });
  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    const isCurrent = () => !cancelled && isEditorRuntimeActive(scope);
    const replay = async () => {
      if (!isCurrent()) return;
      const rows = await listLearningRecords<FocusSessionInput>(scope, focusRecordKind).catch(() => []);
      for (const { id } of rows) {
        if (!isCurrent()) return;
        await withFocusRecordLock(scope, id, async () => {
          if (!isCurrent()) return;
          const input = await readLearningRecord<FocusSessionInput>(scope, focusRecordKind, id);
          if (!input || !isCurrent()) return;
          const saved = await hasSavedFocusRecord(input);
          if (!isCurrent()) return;
          if (saved) void client.invalidateQueries({ queryKey: queryKeys.focusSessions });
          else await recordRef.current(input);
          await removeLearningRecord(scope, focusRecordKind, id, input);
        }).catch(() => { /* The next mount or online event retries the retained record. */ });
      }
    };
    void replay();
    const onOnline = () => { void replay(); };
    window.addEventListener('online', onOnline);
    return () => { cancelled = true; window.removeEventListener('online', onOnline); };
  }, [client, scope]);
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
      document.title = baseTitle.current || t('focus.workspace');
      return;
    }
    const time = formatClock(remainingMs(state, now));
    document.title = t(state.phase === 'focusing' || state.phase === 'focusPaused' ? 'focus.documentFocusing' : 'focus.documentBreaking', { time });
  }, [state, now, t]);
  useEffect(() => () => { document.title = baseTitle.current || t('focus.workspace'); }, [t]);

  return <FocusContext.Provider value={{ state, now, dispatch, remainingLabel: formatClock(remainingMs(state, now)) }}>{children}</FocusContext.Provider>;
}

export function focusPhaseText(state: FocusState) {
  return phaseLabel(state.phase);
}
