import { useEffect, useRef, type PointerEvent, type ReactNode } from 'react';
import { cn } from '@/lib/utils.js';
import { sidebarScrollChrome } from './sidebar-scroll.js';

const HIDE_AFTER_SCROLL_MS = 700;
const HIDE_AFTER_LEAVE_MS = 300;

type Drag = { y: number; top: number; max: number; travel: number };

function paint(scroller: HTMLElement, rail: HTMLElement, thumb: HTMLElement) {
  const chrome = sidebarScrollChrome(scroller.scrollTop, scroller.scrollHeight, scroller.clientHeight);
  rail.classList.toggle('fade-t', chrome.fade === 't');
  rail.classList.toggle('fade-b', chrome.fade === 'b');
  rail.classList.toggle('fade-tb', chrome.fade === 'tb');
  if (chrome.empty) {
    thumb.dataset.empty = 'true';
    thumb.style.height = '0px';
    rail.classList.remove('is-on');
    return;
  }
  delete thumb.dataset.empty;
  thumb.style.height = `${chrome.height}px`;
  thumb.style.transform = `translateY(${chrome.offset}px)`;
}

export function SidebarScroll({ children, className }: { children: ReactNode; className?: string }) {
  const railRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const timerRef = useRef(0);

  useEffect(() => {
    const scroller = scrollerRef.current;
    const rail = railRef.current;
    const thumb = thumbRef.current;
    const content = contentRef.current;
    if (!scroller || !rail || !thumb || !content) return;
    const update = () => paint(scroller, rail, thumb);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(scroller);
    observer.observe(content);
    return () => {
      observer.disconnect();
      window.clearTimeout(timerRef.current);
    };
  }, []);

  function reveal() {
    const rail = railRef.current;
    const thumb = thumbRef.current;
    if (!rail || thumb?.dataset.empty === 'true') return;
    rail.classList.add('is-on');
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      if (dragRef.current || rail.matches(':hover')) return;
      rail.classList.remove('is-on');
    }, HIDE_AFTER_SCROLL_MS);
  }

  function onScroll() {
    const scroller = scrollerRef.current;
    const rail = railRef.current;
    const thumb = thumbRef.current;
    if (!scroller || !rail || !thumb) return;
    paint(scroller, rail, thumb);
    reveal();
  }

  function onLeave() {
    if (dragRef.current) return;
    const rail = railRef.current;
    if (!rail) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      if (dragRef.current || rail.matches(':hover')) return;
      rail.classList.remove('is-on');
    }, HIDE_AFTER_LEAVE_MS);
  }

  function onThumbDown(event: PointerEvent<HTMLDivElement>) {
    const scroller = scrollerRef.current;
    const thumb = thumbRef.current;
    const rail = railRef.current;
    if (!scroller || !thumb || !rail || thumb.dataset.empty === 'true') return;
    event.preventDefault();
    thumb.setPointerCapture(event.pointerId);
    const height = thumb.getBoundingClientRect().height;
    dragRef.current = {
      y: event.clientY,
      top: scroller.scrollTop,
      max: scroller.scrollHeight - scroller.clientHeight,
      travel: Math.max(1, scroller.clientHeight - height),
    };
    rail.classList.add('is-on');
  }

  function onThumbMove(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    const scroller = scrollerRef.current;
    if (!drag || !scroller) return;
    scroller.scrollTop = drag.top + ((event.clientY - drag.y) / drag.travel) * drag.max;
  }

  function endDrag() {
    dragRef.current = null;
    const rail = railRef.current;
    if (!rail || rail.matches(':hover')) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      if (dragRef.current || rail.matches(':hover')) return;
      rail.classList.remove('is-on');
    }, HIDE_AFTER_LEAVE_MS);
  }

  return (
    <div ref={railRef} className="sidebar-rail" onPointerEnter={reveal} onPointerLeave={onLeave}>
      <div ref={scrollerRef} className={cn('sidebar-scroll', className)} onScroll={onScroll}>
        <div ref={contentRef}>{children}</div>
      </div>
      <div
        ref={thumbRef}
        className="sidebar-scroll-thumb"
        aria-hidden="true"
        onPointerDown={onThumbDown}
        onPointerMove={onThumbMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />
    </div>
  );
}
