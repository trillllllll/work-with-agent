import { useLayoutEffect, useId, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { safeSvg } from '@/lib/safe-svg.js';
import { cn } from '@/lib/utils.js';
import type { LearningNode } from './learning-model.js';
import { figureNodeState, figurePick, scopeSvgIds } from './learning-figure.js';
import './learning.css';

/**
 * 学习主图. The assistant draws the layout; the app sanitizes it with the shared SVG policy,
 * colours every data-node-id shape by its saved status and handles clicks itself.
 */
export function LearningFigure({ svg, nodes, currentId, selectedId, onPick, label, className, fallbackStatus }: {
  svg: string; nodes: LearningNode[]; currentId?: string; selectedId?: string; onPick?: (id: string) => void; label: string; className?: string;
  /** Proposal previews draw ids the client cannot resolve yet; show them in this status instead of dimmed. */
  fallbackStatus?: string;
}) {
  const { t } = useTranslation('learning');
  const host = useRef<HTMLDivElement>(null);
  const scope = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  // safeSvg applies the same element/attribute policy as chat SVG blocks (no script, events,
  // links or foreignObject), so the result can be placed inline and receive app-owned clicks.
  const clean = useMemo(() => { try { return { svg: scopeSvgIds(safeSvg(svg), `lf${scope}`), error: '' }; } catch (error) { return { svg: '', error: error instanceof Error ? error.message : String(error) }; } }, [svg, scope]);
  // Keep React from replacing identical markup and removing app-owned shape
  // state during a parent render where the layout effect has no changed inputs.
  const markup = useMemo(() => ({ __html: clean.svg }), [clean.svg]);
  useLayoutEffect(() => {
    host.current?.querySelectorAll<SVGElement>('[data-node-id]').forEach(element => {
      const state = figureNodeState(element.getAttribute('data-node-id') ?? '', nodes, currentId, selectedId);
      element.setAttribute('data-status', state?.status ?? fallbackStatus ?? 'missing');
      element.toggleAttribute('data-current', Boolean(state?.current));
      element.toggleAttribute('data-selected', Boolean(state?.selected));
      const shapes = element.matches('rect,circle,ellipse,path,polygon') ? [element] : Array.from(element.querySelectorAll<SVGElement>('rect,circle,ellipse,path,polygon'));
      for (const shape of shapes) {
        shape.setAttribute('data-figure-status', state?.status ?? fallbackStatus ?? 'missing');
        shape.toggleAttribute('data-figure-current', Boolean(state?.current));
        shape.toggleAttribute('data-figure-selected', Boolean(state?.selected));
      }
      if (state && onPick) {
        element.setAttribute('tabindex', '0');
        element.setAttribute('role', 'button');
        element.setAttribute('aria-label', t('figure.openNode', { title: state.title, status: t(`status.${state.status}`) }));
      } else {
        element.removeAttribute('tabindex');
        element.removeAttribute('role');
        element.removeAttribute('aria-label');
      }
    });
  }, [clean.svg, nodes, currentId, selectedId, onPick, t, fallbackStatus]);
  function pick(target: EventTarget | null) {
    if (!onPick || !(target instanceof Element)) return;
    const id = figurePick(target.closest('[data-node-id]')?.getAttribute('data-node-id'), nodes);
    if (id) onPick(id);
  }
  if (clean.error) return <p role="alert" className="text-xs text-destructive">{t('figure.invalid', { error: clean.error })}</p>;
  return <div ref={host} className={cn('learning-figure', className)} data-testid="learning-figure" data-clickable={onPick ? 'true' : undefined} role="group" aria-label={label}
    onClick={event => pick(event.target)}
    onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { const target = event.target; if (target instanceof Element && target.closest('[data-node-id]')) { event.preventDefault(); pick(target); } } }}
    dangerouslySetInnerHTML={markup} />;
}
