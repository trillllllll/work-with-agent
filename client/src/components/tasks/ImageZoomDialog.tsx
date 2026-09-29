import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog.js';
import { Button } from '@/components/ui/button.js';

const minScale = 0.25;
const maxScale = 4;

type Size = { width: number; height: number };
type Point = { x: number; y: number };

function clampScale(value: number) {
  return Math.min(maxScale, Math.max(minScale, value));
}

function fitScale(view: Size, natural: Size) {
  if (!natural.width || !natural.height || !view.width || !view.height) return 1;
  return clampScale(Math.min(1, view.width / natural.width, view.height / natural.height));
}

function centeredOffset(view: Size, natural: Size, scale: number): Point {
  return { x: (view.width - natural.width * scale) / 2, y: (view.height - natural.height * scale) / 2 };
}

function clampOffset(offset: Point, view: Size, display: Size): Point {
  const axis = (value: number, viewSize: number, displaySize: number) => {
    if (displaySize <= viewSize) return (viewSize - displaySize) / 2;
    return Math.min(0, Math.max(viewSize - displaySize, value));
  };
  return { x: axis(offset.x, view.width, display.width), y: axis(offset.y, view.height, display.height) };
}

function ZoomFrame({ src }: { src: string }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<Size>({ width: 0, height: 0 });
  const [view, setView] = useState<Size>({ width: 0, height: 0 });
  const [mode, setMode] = useState<'fit' | number>('fit');
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const naturalRef = useRef(natural);
  const viewRef = useRef(view);
  const offsetRef = useRef(offset);
  const scaleRef = useRef(1);
  const dragRef = useRef<{ x: number; y: number; origin: Point } | null>(null);
  naturalRef.current = natural;
  viewRef.current = view;
  offsetRef.current = offset;

  const scale = mode === 'fit' ? fitScale(view, natural) : mode;
  scaleRef.current = scale;
  const display = { width: natural.width * scale, height: natural.height * scale };
  const canPan = display.width > view.width + 1 || display.height > view.height + 1;

  useLayoutEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const update = () => {
      const next = { width: node.clientWidth, height: node.clientHeight };
      viewRef.current = next;
      setView(next);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (mode !== 'fit') return;
    const next = centeredOffset(view, natural, scale);
    offsetRef.current = next;
    setOffset(next);
  }, [mode, view, natural, scale]);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const current = scaleRef.current;
      const image = naturalRef.current;
      const frame = viewRef.current;
      if (!image.width || !frame.width) return;
      const next = clampScale(current * (event.deltaY < 0 ? 1.25 : 1 / 1.25));
      const rect = node.getBoundingClientRect();
      const originX = event.clientX - rect.left;
      const originY = event.clientY - rect.top;
      const placed = offsetRef.current;
      const imageX = (originX - placed.x) / current;
      const imageY = (originY - placed.y) / current;
      const moved = clampOffset(
        { x: originX - imageX * next, y: originY - imageY * next },
        frame,
        { width: image.width * next, height: image.height * next },
      );
      scaleRef.current = next;
      offsetRef.current = moved;
      setMode(next);
      setOffset(moved);
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, []);

  const zoomBy = (factor: number) => {
    const current = scaleRef.current;
    const next = clampScale(current * factor);
    if (Math.abs(next - current) < 0.001) return;
    const frame = viewRef.current;
    const image = naturalRef.current;
    const placed = offsetRef.current;
    const originX = frame.width / 2;
    const originY = frame.height / 2;
    const imageX = (originX - placed.x) / current;
    const imageY = (originY - placed.y) / current;
    const moved = clampOffset(
      { x: originX - imageX * next, y: originY - imageY * next },
      frame,
      { width: image.width * next, height: image.height * next },
    );
    scaleRef.current = next;
    offsetRef.current = moved;
    setMode(next);
    setOffset(moved);
  };

  const showActual = () => {
    const frame = viewRef.current;
    const image = naturalRef.current;
    const moved = clampOffset(centeredOffset(frame, image, 1), frame, image);
    scaleRef.current = 1;
    offsetRef.current = moved;
    setMode(1);
    setOffset(moved);
  };

  return <div>
    <div
      ref={viewportRef}
      className="relative h-[min(64dvh,720px)] w-full touch-none overflow-hidden"
      style={{ cursor: dragging ? 'grabbing' : canPan ? 'grab' : 'default' }}
      onPointerDown={(event) => {
        if (event.button !== 0 || !canPan) return;
        dragRef.current = { x: event.clientX, y: event.clientY, origin: offsetRef.current };
        setDragging(true);
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag) return;
        const image = naturalRef.current;
        const next = scaleRef.current;
        setOffset(clampOffset(
          { x: drag.origin.x + event.clientX - drag.x, y: drag.origin.y + event.clientY - drag.y },
          viewRef.current,
          { width: image.width * next, height: image.height * next },
        ));
      }}
      onPointerUp={() => { dragRef.current = null; setDragging(false); }}
      onPointerCancel={() => { dragRef.current = null; setDragging(false); }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <img
        src={src}
        alt=""
        draggable={false}
        className="absolute left-0 top-0 max-w-none select-none"
        style={{ width: display.width || undefined, height: display.height || undefined, transform: `translate(${offset.x}px, ${offset.y}px)` }}
        onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
      />
    </div>
    <div className="mt-3 flex flex-wrap items-center justify-center gap-1">
      <Button type="button" variant="outline" size="sm" aria-label="缩小" disabled={scale <= minScale + 0.001} onClick={() => zoomBy(1 / 1.25)}>缩小</Button>
      <Button type="button" variant="outline" size="sm" aria-label="放大" disabled={scale >= maxScale - 0.001} onClick={() => zoomBy(1.25)}>放大</Button>
      <Button type="button" variant="outline" size="sm" aria-label="适应窗口" onClick={() => setMode('fit')}>适应窗口</Button>
      <Button type="button" variant="outline" size="sm" aria-label="实际大小" onClick={showActual}>实际大小</Button>
      {natural.width > 0 && <span className="min-w-12 text-center text-xs tabular-nums text-muted-foreground">{Math.round(scale * 100)}%</span>}
    </div>
  </div>;
}

export function ImageZoomDialog({ src, onClose }: { src: string | null; onClose: () => void }) {
  return <Dialog open={src != null} onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent surface="glass" className="max-h-[92dvh] max-w-[min(72rem,calc(100%-3rem))] overflow-y-auto">
      <DialogTitle className="sr-only">图片预览</DialogTitle>
      {src && <ZoomFrame key={src} src={src} />}
    </DialogContent>
  </Dialog>;
}
