import { useEffect, useId, useRef, useState } from 'react';
import { useTheme } from 'next-themes';
import { Button } from '@/components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';

export function MermaidBlock({ source }: { source: string }) {
  const { resolvedTheme } = useTheme();
  const reactId = useId().replace(/:/g, '');
  const attempt = useRef(0);
  const [svg, setSvg] = useState('');
  const [failed, setFailed] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const id = `mmd${reactId}${attempt.current++}`;
    setFailed(false);
    (async () => {
      const mermaid = (await import('mermaid')).default;
      // Frontmatter in the diagram cannot override these keys.
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize'],
        htmlLabels: false,
        suppressErrorRendering: true,
        logLevel: 'fatal',
        fontFamily: 'inherit',
        theme: resolvedTheme === 'dark' ? 'dark' : 'default',
      });
      const parsed = await mermaid.parse(source, { suppressErrors: true });
      if (cancelled) return;
      if (parsed === false) {
        setSvg('');
        setFailed(true);
        return;
      }
      const rendered = await mermaid.render(id, source);
      if (cancelled) return;
      if (!rendered.svg.includes('<svg') || /<script/i.test(rendered.svg)) {
        setSvg('');
        setFailed(true);
        return;
      }
      setSvg(rendered.svg);
    })().catch(() => {
      if (!cancelled) {
        setSvg('');
        setFailed(true);
      }
    });
    return () => { cancelled = true; };
  }, [source, resolvedTheme, reactId]);

  const frame = (markup: string, zoom: boolean) => (
    <div
      className={zoom ? 'overflow-auto [&_svg]:h-auto [&_svg]:!max-w-none' : 'overflow-x-auto [&_svg]:h-auto [&_svg]:!max-w-full'}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );

  return (
    <div data-mermaid-block className="my-2 rounded-lg border border-border bg-muted/30 p-2">
      <div className="mb-2 flex gap-2">
        {!failed && <Button type="button" variant="outline" size="xs" aria-pressed={showSource} onClick={() => setShowSource((value) => !value)}>{showSource ? '图' : '源码'}</Button>}
        <Button type="button" variant="outline" size="xs" disabled={!svg || failed} onClick={() => setOpen(true)}>放大</Button>
      </div>
      {failed ? (
        <>
          <p role="status" className="mb-2 text-xs text-destructive">这张图画不出来</p>
          <pre className="overflow-x-auto rounded-lg bg-[#0d1117] p-3 text-xs leading-relaxed text-zinc-100">{source}</pre>
        </>
      ) : showSource ? (
        <pre className="overflow-x-auto rounded-lg bg-[#0d1117] p-3 text-xs leading-relaxed text-zinc-100">{source}</pre>
      ) : svg && !open ? frame(svg, false) : (
        <p className="text-xs text-muted-foreground">正在画图…</p>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[min(85dvh,calc(100%-3rem))] max-w-[min(56rem,calc(100%-3rem))] overflow-auto">
          <DialogHeader>
            <DialogTitle>图</DialogTitle>
            <DialogDescription className="sr-only">放大后的图</DialogDescription>
          </DialogHeader>
          {svg && frame(svg, true)}
        </DialogContent>
      </Dialog>
    </div>
  );
}
