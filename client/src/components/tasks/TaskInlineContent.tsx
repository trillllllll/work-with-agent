import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Tag, Task } from '@/lib/api.js';
import { cn } from '@/lib/utils.js';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.js';
import { TooltipProvider, TooltipRoot, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip.js';
import { fitInlineTags, tagInitial } from './task-inline.js';

type Info = { key: string; text: string; className: string };
function contain(event: { stopPropagation(): void }) { event.stopPropagation(); }

export function TaskInlineContent({ task, info, preview, onOpen }: { task: Task; info: Info[]; preview?: boolean; onOpen(): void }) {
  const { t } = useTranslation('tasks');
  const root = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState({ short: false, visible: task.tags?.length ?? 0, compact: false, summary: false, mergeInfo: false });
  const tags = task.tags ?? [];
  const signature = JSON.stringify([task.title, info, tags.map(tag => [tag.id, tag.name, tag.color])]);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    let frame = 0, alive = true;
    const measure = () => {
      const probe = element.querySelector<HTMLElement>('.task-inline-measure')!;
      const compact = element.clientWidth < 320;
      const widthOf = (selector: string) => [...probe.querySelectorAll<HTMLElement>(selector)].map(el => el.getBoundingClientRect().width);
      const infoWidth = probe.querySelector<HTMLElement>(compact ? '.task-info-short' : '.task-info-full')!.getBoundingClientRect().width;
      const summary = compact && info.length > 1 && infoWidth > element.clientWidth * .25;
      const mergeInfo = tags.length > 0 && element.clientWidth < 128;
      const metadata = mergeInfo ? 0 : summary ? probe.querySelector<HTMLElement>('.task-info-summary')!.getBoundingClientRect().width : infoWidth;
      const title = probe.querySelector<HTMLElement>('.task-inline-title-measure')!.getBoundingClientRect().width;
      const counts = widthOf('[data-measure-count]');
      const next = { ...fitInlineTags(element.clientWidth, title, metadata, widthOf('[data-measure-full]'), widthOf('[data-measure-initial]'), n => counts[n - 1] ?? 0), compact, summary, mergeInfo };
      setLayout(old => old.short === next.short && old.visible === next.visible && old.compact === next.compact && old.summary === next.summary && old.mergeInfo === next.mergeInfo ? old : next);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    observer.observe(element.querySelector('.task-inline-measure')!);
    void document.fonts.ready.then(() => { if (alive) schedule(); });
    return () => { alive = false; observer.disconnect(); cancelAnimationFrame(frame); };
  }, [signature]);

  const infoItems = (compact: boolean) => info.map(item => <span key={item.key} className={item.className}>{compact ? tagInitial(item.text) : item.text}</span>);
  const tag = (item: Tag, short: boolean) => <span className="task-tag-chip" data-color={item.color || 'violet'} title={item.name}>{short ? tagInitial(item.name) : `#${item.name}`}</span>;
  const names = tags.map(item => item.name).join(' · ');
  const infoText = info.map(item => item.text).join(' · ');
  const tagHint = [layout.mergeInfo ? infoText : '', names].filter(Boolean).join(' · ');
  const hidden = tags.length - layout.visible;
  const tagContents = <>{tags.slice(0, layout.visible).map(item => <span key={item.id}>{tag(item, layout.short)}</span>)}{hidden > 0 && <span className="task-meta-pill task-tag-count">+{hidden}</span>}</>;
  return <div ref={root} className="task-inline-content" data-short-tags={layout.short || undefined} data-compact-info={layout.compact || undefined}>
    <button type="button" aria-label={task.title} title={task.title} className="task-inline-open" disabled={preview} onClick={event => { contain(event); onOpen(); }}>
      <span className={cn('task-inline-title', task.status === 'done' && 'text-muted-foreground line-through')}>{task.title}</span>
    </button>
    {info.length > 0 && !layout.mergeInfo && <TooltipProvider><TooltipRoot><TooltipTrigger asChild><span className="task-inline-info" tabIndex={preview ? undefined : 0} aria-label={info.map(item => item.text).join(' · ')} onPointerDown={contain} onMouseDown={contain} onTouchStart={contain} onClick={contain}>{layout.summary ? <span className="task-meta-pill">{tagInitial(info[0].text)}·</span> : infoItems(layout.compact)}</span></TooltipTrigger><TooltipContent onMouseDown={contain} onTouchStart={contain} onPointerDown={contain} onClick={contain}>{info.map(item => item.text).join(' · ')}</TooltipContent></TooltipRoot></TooltipProvider>}
    {tags.length > 0 && (preview ? <span className="task-inline-tags">{tagContents}</span> : <Popover>
      <TooltipProvider><TooltipRoot><TooltipTrigger asChild><PopoverTrigger asChild>
        <button type="button" className="task-inline-tags" aria-label={t('taskList.showTags', { names: tagHint })} title={tagHint} onPointerDown={contain} onMouseDown={contain} onTouchStart={contain} onClick={contain}>{tagContents}</button>
      </PopoverTrigger></TooltipTrigger><TooltipContent onMouseDown={contain} onTouchStart={contain} onPointerDown={contain} onClick={contain}>{tagHint}</TooltipContent></TooltipRoot></TooltipProvider>
      <PopoverContent className="task-tag-popover" aria-label={t('taskList.tags')} onPointerDown={contain} onMouseDown={contain} onTouchStart={contain} onClick={contain}>
        {layout.mergeInfo && <p className="mb-2 text-xs">{infoText}</p>}<p className="mb-2 text-xs text-muted-foreground">{t('taskList.tags')}</p><div className="flex flex-wrap gap-1.5">{tags.map(item => <span key={item.id}>{tag(item, false)}</span>)}</div>
      </PopoverContent>
    </Popover>)}
    <div className="task-inline-probe" aria-hidden="true" inert><div className="task-inline-measure">
      <span className="task-inline-title-measure" data-measure-text={task.title} />
      <span className="task-inline-info task-info-full">{info.map(item => <span key={item.key} className={item.className} data-measure-text={item.text} />)}</span>
      <span className="task-inline-info task-info-short">{info.map(item => <span key={item.key} className={item.className} data-measure-text={tagInitial(item.text)} />)}</span>
      <span className="task-inline-info task-info-summary"><span className="task-meta-pill" data-measure-text={info.length ? `${tagInitial(info[0].text)}·` : ''} /></span>
      {tags.map(item => <span key={`full-${item.id}`} className="task-tag-chip" data-measure-full data-measure-text={`#${item.name}`} />)}
      {tags.map(item => <span key={`short-${item.id}`} className="task-tag-chip task-tag-initial-measure" data-measure-initial data-measure-text={tagInitial(item.name)} />)}
      {tags.map((item, index) => <span key={`count-${item.id}`} className="task-meta-pill" data-measure-count data-measure-text={`+${index + 1}`} />)}
    </div></div>
  </div>;
}
