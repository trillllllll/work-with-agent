import { useTranslation } from 'react-i18next';
import { Pause, Play } from 'lucide-react';
import { useHashRoute } from '@/hooks/useHashRoute.js';
import { focusPhaseText, useFocus } from './FocusProvider.js';

export function FocusChip() {
  const { t } = useTranslation('plan');
  const { state, dispatch, remainingLabel } = useFocus();
  const { navigate } = useHashRoute();
  if (state.phase === 'idle') return null;
  const running = state.phase === 'focusing' || state.phase === 'breaking';
  return (
    <div role="button" tabIndex={0} data-testid="focus-chip" className="glass-surface fixed right-4 bottom-4 z-50 flex h-10 max-w-[260px] cursor-pointer items-center gap-2 rounded-full pr-1.5 pl-3 text-sm shadow-[var(--glass-shadow)] max-md:bottom-20" onClick={() => navigate('focus')} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); navigate('focus'); } }}>
      <span className="tabular-nums">{remainingLabel}</span>
      <span className="max-w-[120px] truncate text-muted-foreground">{state.taskTitle || focusPhaseText(state)}</span>
      <button type="button" aria-label={running ? t('focus.pause') : t('focus.resume')} className="glass-control grid size-7 place-items-center rounded-full" onClick={(event) => { event.stopPropagation(); dispatch(running ? { type: 'PAUSE', now: Date.now() } : { type: 'RESUME', now: Date.now() }); }}>
        {running ? <Pause className="size-4" strokeWidth={1.75} /> : <Play className="size-4" strokeWidth={1.75} />}
      </button>
    </div>
  );
}
