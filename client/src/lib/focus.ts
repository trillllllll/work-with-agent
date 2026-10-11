import { localDateTime } from './schedule.js';

export type FocusPhase = 'idle' | 'focusing' | 'focusPaused' | 'breakReady' | 'breaking' | 'breakPaused';
export type FocusState = {
  phase: FocusPhase;
  taskId: string | null;
  taskTitle: string | null;
  accumulatedMs: number;
  segmentStartedAt: number | null;
  sessionStartedAt: string | null;
  plannedMinutes: number;
  breakMinutes: number;
  cycle: number;
  autoStartBreak: boolean;
};
export type FocusEffect =
  | { type: 'FOCUS_COMPLETED'; taskId: string | null; startedAt: string; endedAt: string; durationMinutes: number; plannedMinutes: number; completed: boolean }
  | { type: 'BREAK_COMPLETED' };
export type FocusAction =
  | { type: 'START'; taskId: string | null; taskTitle: string | null; now: number }
  | { type: 'PAUSE'; now: number }
  | { type: 'RESUME'; now: number }
  | { type: 'TICK'; now: number }
  | { type: 'SKIP_BREAK' }
  | { type: 'STOP_EARLY'; now: number }
  | { type: 'SET_TASK'; taskId: string | null; taskTitle: string | null }
  | { type: 'SET_DURATIONS'; plannedMinutes: number; breakMinutes: number; autoStartBreak?: boolean };

export const initialFocusState: FocusState = {
  phase: 'idle',
  taskId: null,
  taskTitle: null,
  accumulatedMs: 0,
  segmentStartedAt: null,
  sessionStartedAt: null,
  plannedMinutes: 25,
  breakMinutes: 5,
  cycle: 0,
  autoStartBreak: false,
};

const storageKey = 'todo.focusTimer';

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}
function elapsedMs(state: FocusState, now: number) {
  return state.accumulatedMs + (state.segmentStartedAt ? Math.max(0, now - state.segmentStartedAt) : 0);
}
function idle(state: FocusState): FocusState {
  return { ...state, phase: 'idle', accumulatedMs: 0, segmentStartedAt: null };
}

export function focusReducer(state: FocusState, action: FocusAction): { state: FocusState; effects: FocusEffect[] } {
  if (action.type === 'START') {
    if (state.phase !== 'idle') return { state, effects: [] };
    return {
      state: {
        ...state,
        phase: 'focusing',
        taskId: action.taskId,
        taskTitle: action.taskTitle,
        accumulatedMs: 0,
        segmentStartedAt: action.now,
        sessionStartedAt: localDateTime(new Date(action.now)),
        cycle: 0,
      },
      effects: [],
    };
  }
  if (action.type === 'PAUSE') {
    if (state.phase !== 'focusing' && state.phase !== 'breaking') return { state, effects: [] };
    return { state: { ...state, phase: state.phase === 'focusing' ? 'focusPaused' : 'breakPaused', accumulatedMs: elapsedMs(state, action.now), segmentStartedAt: null }, effects: [] };
  }
  if (action.type === 'RESUME') {
    if (state.phase !== 'focusPaused' && state.phase !== 'breakPaused' && state.phase !== 'breakReady') return { state, effects: [] };
    const nextPhase = state.phase === 'focusPaused' ? 'focusing' : 'breaking';
    const accumulatedMs = state.phase === 'breakReady' && state.accumulatedMs > 0 ? 0 : state.accumulatedMs;
    return { state: { ...state, phase: nextPhase, accumulatedMs, segmentStartedAt: action.now }, effects: [] };
  }
  if (action.type === 'TICK') {
    if (state.phase !== 'focusing' && state.phase !== 'breaking') return { state, effects: [] };
    const total = elapsedMs(state, action.now);
    if (state.phase === 'focusing' && total >= state.plannedMinutes * 60000 && state.sessionStartedAt) {
      return {
        state: {
          ...state,
          phase: state.autoStartBreak ? 'breaking' : 'breakReady',
          accumulatedMs: 0,
          segmentStartedAt: state.autoStartBreak ? action.now : null,
          cycle: state.cycle + 1,
        },
        effects: [{ type: 'FOCUS_COMPLETED', taskId: state.taskId, startedAt: state.sessionStartedAt, endedAt: localDateTime(new Date(action.now)), durationMinutes: state.plannedMinutes, plannedMinutes: state.plannedMinutes, completed: true }],
      };
    }
    if (state.phase === 'breaking' && total >= state.breakMinutes * 60000) {
      return { state: { ...state, phase: 'idle', segmentStartedAt: null, accumulatedMs: 0 }, effects: [{ type: 'BREAK_COMPLETED' }] };
    }
    return { state, effects: [] };
  }
  if (action.type === 'SKIP_BREAK') {
    if (state.phase !== 'breakReady' && state.phase !== 'breaking' && state.phase !== 'breakPaused') return { state, effects: [] };
    return { state: { ...state, phase: 'idle', segmentStartedAt: null }, effects: [] };
  }
  if (action.type === 'STOP_EARLY') {
    if (state.phase !== 'focusing' && state.phase !== 'focusPaused') return { state, effects: [] };
    const totalMin = Math.floor(elapsedMs(state, action.now) / 60000);
    const effects: FocusEffect[] = totalMin >= 1 && state.sessionStartedAt
      ? [{ type: 'FOCUS_COMPLETED', taskId: state.taskId, startedAt: state.sessionStartedAt, endedAt: localDateTime(new Date(action.now)), durationMinutes: totalMin, plannedMinutes: state.plannedMinutes, completed: false }]
      : [];
    return { state: idle(state), effects };
  }
  if (action.type === 'SET_TASK') {
    if (state.phase !== 'idle') return { state, effects: [] };
    return { state: { ...state, taskId: action.taskId, taskTitle: action.taskTitle }, effects: [] };
  }
  if (state.phase !== 'idle') return { state, effects: [] };
  return { state: { ...state, plannedMinutes: clamp(action.plannedMinutes, 5, 120), breakMinutes: clamp(action.breakMinutes, 1, 30), autoStartBreak: action.autoStartBreak ?? state.autoStartBreak }, effects: [] };
}

export function totalMs(state: FocusState) {
  if (state.phase === 'focusing' || state.phase === 'focusPaused') return state.plannedMinutes * 60000;
  if (state.phase === 'breaking' || state.phase === 'breakPaused' || state.phase === 'breakReady') return state.breakMinutes * 60000;
  return state.plannedMinutes * 60000;
}
export function remainingMs(state: FocusState, now: number) {
  if (state.phase === 'idle') return state.plannedMinutes * 60000;
  return Math.max(0, totalMs(state) - elapsedMs(state, now));
}
export function elapsedRatio(state: FocusState, now: number) {
  const total = state.phase === 'idle' ? state.plannedMinutes * 60000 : totalMs(state);
  if (!total) return 0;
  return Math.min(1, Math.max(0, elapsedMs(state, now) / total));
}
export function formatClock(ms: number) {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
export function phaseLabel(phase: FocusPhase) {
  if (phase === 'focusing') return '专注中';
  if (phase === 'focusPaused' || phase === 'breakPaused') return '已暂停';
  if (phase === 'breaking' || phase === 'breakReady') return '休息一下';
  return '准备专注';
}
export function loadFocusState(): FocusState {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return initialFocusState;
    const parsed = JSON.parse(raw) as FocusState;
    if (!parsed || typeof parsed !== 'object' || !parsed.phase) return initialFocusState;
    const now = Date.now();
    if (parsed.phase === 'focusing' || parsed.phase === 'breaking') {
      return {
        ...initialFocusState,
        ...parsed,
        phase: parsed.phase === 'focusing' ? 'focusPaused' : 'breakPaused',
        accumulatedMs: elapsedMs(parsed, now),
        segmentStartedAt: null,
      };
    }
    return { ...initialFocusState, ...parsed, segmentStartedAt: parsed.phase === 'focusPaused' || parsed.phase === 'breakPaused' || parsed.phase === 'breakReady' || parsed.phase === 'idle' ? null : parsed.segmentStartedAt };
  } catch {
    return initialFocusState;
  }
}
export function saveFocusState(state: FocusState) {
  localStorage.setItem(storageKey, JSON.stringify(state));
}
export function beep() {
  try {
    const audio = new AudioContext();
    const start = audio.currentTime;
    [0, 0.35].forEach((offset) => {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.frequency.value = 880;
      osc.connect(gain);
      gain.connect(audio.destination);
      const at = start + offset;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.08, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.15);
      osc.start(at);
      osc.stop(at + 0.15);
    });
    window.setTimeout(() => void audio.close(), 900);
  } catch { /* 音频不可用时保持计时本身可用 */ }
}
export function notify(title: string) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try { new Notification(title); } catch { /* 通知被系统拒绝时忽略 */ }
}
