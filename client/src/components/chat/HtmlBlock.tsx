import { cleanHtmlFragments, fragmentDocument } from '@/lib/html-fragments.js';
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useTheme } from 'next-themes';
import { Download, Maximize2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { Button } from '@/components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';
import type { ContentBlock } from '@/lib/message-blocks.js';
import { buildCsp, buildSrcdoc, clampHeight, createNavigationGuard, createNonce, DEFAULT_HEIGHT, FILL_THROTTLE_MS, readBridgeMessage, themeCss, type SandboxTheme } from '@/lib/html-sandbox.js';
import { save, VisualFrame } from './VisualizationBlock.js';
import { lazyObserverOptions, isNearHtmlViewport } from './html-block-visibility.js';
import { useAssistantInput } from './assistant-input.js';

export type HtmlBlockSettings = { enabled: boolean; cdn: string[]; defaults: string[] };
export const htmlBlockSettingsKey = ['html-block-settings'] as const;
export function useHtmlBlockSettings() {
  return useQuery({ queryKey: htmlBlockSettingsKey, queryFn: () => api<HtmlBlockSettings>('/api/settings/html-blocks'), staleTime: 60_000 });
}

function SourceFallback({ block, message }: { block: ContentBlock; message: string }) {
  return <div className="p-4 text-xs"><p role="status" className="text-muted-foreground">{message}</p>{block.alt && <p className="mt-1">{block.alt}</p>}<pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words">{block.source}</pre></div>;
}

/**
 * One sandboxed document. sandbox="allow-scripts" only: the page gets an opaque origin, so it cannot
 * read this app's DOM, storage or cookies, and the CSP in its srcdoc stops every network path except the CDN allowlist.
 */
export function HtmlFrame({ block, cdn, theme, maxHeight, title, onPaint }: { block: ContentBlock; cdn: string[]; theme: SandboxTheme; maxHeight?: number; title: string; onPaint?: (complete: boolean) => void }) {
  const { t } = useTranslation('chat');
  const frame = useRef<HTMLIFrameElement>(null);
  const input = useAssistantInput();
  const [height, setHeight] = useState(() => clampHeight(block.height ?? DEFAULT_HEIGHT, maxHeight));
  const [blocked, setBlocked] = useState(false);
  const [hidden, setHidden] = useState(false);
  const lastFill = useRef(0);
  const [bridgeReady, setBridgeReady] = useState(false);
  const [finished, setFinished] = useState(false);
  const [fragmentError, setFragmentError] = useState('');
  const latest = useRef({ block, onPaint }); latest.current = { block, onPaint };
  // The document is built once per mount: theme changes are pushed by message so the page keeps its state.
  const [{ nonce, srcDoc }] = useState(() => {
    const created = createNonce();
    return { nonce: created, srcDoc: buildSrcdoc(block.renderMode === 'fragments' ? fragmentDocument(created) : block.source ?? '', { cdn, theme, nonce: created }) };
  });
  const [guard] = useState(() => createNavigationGuard({
    setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimer: (handle) => window.clearTimeout(handle),
    onHide: () => setHidden(true),
    onShow: () => setHidden(false),
    onBlock: () => setBlocked(true),
  }));
  // Layout, not passive effect: the listener must be in place before the iframe load message arrives.
  useLayoutEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const own = frame.current?.contentWindow;
      if (!own || event.source !== own || event.origin !== 'null') return;
      if (event.data?.type === 'wwa:paint' && event.data.nonce === nonce && Number.isInteger(event.data.count) && typeof event.data.done === 'boolean') {
        setFinished(event.data.done); if (event.data.count > 0) latest.current.onPaint?.(event.data.done); return;
      }
      const message = readBridgeMessage(event.data);
      if (!message || message.nonce !== nonce) return;
      if (message.type === 'ready') { guard.ready(); setBridgeReady(true); return; }
      if (message.type === 'alive') { guard.alive(message.id); return; }
      if (message.type === 'resize') { setHeight(clampHeight(message.height, maxHeight)); return; }
      // Filling needs a user who has interacted with this page, and is throttled.
      if (document.activeElement !== frame.current) return;
      const now = Date.now();
      if (now - lastFill.current < FILL_THROTTLE_MS) return;
      lastFill.current = now;
      if (message.type === 'invalid') { toast.error(message.reason); return; }
      if (!input) { toast.error(t('html.onlyInAssistant')); return; }
      input.fill(message.text, block.id);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [block.id, guard, input, maxHeight, nonce, t]);
  useLayoutEffect(() => () => guard.dispose(), [guard]);
  useEffect(() => { frame.current?.contentWindow?.postMessage({ type: 'wwa:theme', theme, css: themeCss(theme) }, '*'); }, [theme, bridgeReady]);
  useEffect(() => {
    if (!bridgeReady || finished || block.renderMode !== 'fragments') return;
    let attempted = ''; let sent = ''; let accepted: string[] = [];
    const update = () => {
      const current = latest.current.block;
      const inputKey = JSON.stringify([current.source, current.status]);
      if (attempted === inputKey) return;
      attempted = inputKey;
      try {
        const done = current.status === 'ready';
        const snapshot = cleanHtmlFragments(current.source ?? '', done);
        if (accepted.some((part, i) => snapshot.parts[i] !== part)) throw new Error(t('html.fragmentConflict'));
        const identity = JSON.stringify([snapshot.parts, done]);
        if (identity === sent) return;
        sent = identity; accepted = snapshot.parts;
        frame.current?.contentWindow?.postMessage({ type: 'wwa:fragments', nonce, ...snapshot, done }, '*');
      } catch (error) { setFragmentError(error instanceof Error ? error.message : t('html.fragmentConflict')); }
    };
    const timer = window.setInterval(update, 160); update();
    return () => window.clearInterval(timer);
  }, [bridgeReady, finished, block.renderMode, nonce, t]);
  if (blocked) return <SourceFallback block={block} message={t('html.navigatedAway')} />;
  return <>{block.renderMode === 'fragments' && !finished && !fragmentError && <p role="status" className="px-3 py-2 text-xs text-muted-foreground">{t(block.status === 'ready' ? 'visualization.rendering' : block.status === 'error' ? 'messageBlocks.partIncomplete' : 'messageBlocks.generating')}</p>}{fragmentError && <p role="alert" className="p-3 text-xs text-destructive">{t('html.fragmentIncomplete', { error: fragmentError })}</p>}<iframe ref={frame} title={title} data-testid="html-block-frame" sandbox="allow-scripts" srcDoc={srcDoc} referrerPolicy="no-referrer" allow="" {...{ csp: buildCsp(cdn) }}
    className="block w-full border-0 bg-transparent" style={{ height, visibility: hidden ? 'hidden' : undefined }}
    // An unconfirmed load pings whatever document is in the frame now; only our bridge can answer with the nonce.
    onLoad={() => { const load = guard.load(); if (load.pending) frame.current?.contentWindow?.postMessage({ type: 'wwa:ping', id: load.id }, '*'); }} /></>;
}

function exportDocument(block: ContentBlock, cdn: string[], theme: SandboxTheme, title: string) {
  const name = `${(title || 'page').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 60) || 'page'}.html`;
  save(new Blob([buildSrcdoc(block.source ?? '', { cdn, theme, bridge: false })], { type: 'text/html' }), name);
}

export default memo(function HtmlBlock({ block }: { block: ContentBlock }) {
  const { t } = useTranslation('chat');
  const { resolvedTheme } = useTheme(); const theme: SandboxTheme = resolvedTheme === 'dark' ? 'dark' : 'light';
  const settings = useHtmlBlockSettings();
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(typeof IntersectionObserver === 'undefined');
  const [large, setLarge] = useState(false);
  const title = block.title || t('html.defaultTitle');
  const ready = Boolean(settings.data?.enabled);
  // Arm only once the placeholder has its reserved height: while settings load the block is one line tall,
  // so every block of a fresh reply would sit inside the preload margin and mount at once.
  useEffect(() => {
    if (visible || !ready || !host.current) return;
    const node = host.current;
    const options = lazyObserverOptions(node);
    const root = options.root instanceof Element ? options.root : null;
    let scheduled = 0;
    const check = () => { scheduled = 0; if (isNearHtmlViewport(node, root, { width: innerWidth, height: innerHeight })) setVisible(true); };
    // Let the parent ResizeObserver restore its bottom position before measuring. Intersection
    // entries can also describe the pre-resize layout, so always recheck current geometry.
    const schedule = () => { if (!scheduled) scheduled = requestAnimationFrame(() => { scheduled = requestAnimationFrame(check); }); };
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) schedule(); }, options);
    observer.observe(node);
    const resize = new ResizeObserver(schedule); resize.observe(node); if (root) resize.observe(root);
    root?.addEventListener('scroll', schedule, { passive: true }); window.addEventListener('resize', schedule); schedule();
    return () => { observer.disconnect(); resize.disconnect(); cancelAnimationFrame(scheduled); root?.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule); };
  }, [visible, ready]);
  const cdn = settings.data?.cdn ?? [];
  const body = settings.isLoading ? <p role="status" className="p-4 text-xs text-muted-foreground">{t('html.preparing')}</p>
    : settings.isError ? <SourceFallback block={block} message={t('html.settingsUnreadable')} />
    : !settings.data?.enabled ? <SourceFallback block={block} message={t('html.disabled')} />
    : visible ? <HtmlFrame block={block} cdn={cdn} theme={theme} title={title} />
    : <div style={{ height: clampHeight(block.height ?? DEFAULT_HEIGHT) }} />;
  return <div ref={host} data-testid="html-block">
    <VisualFrame title={title} source={block.source ?? ''} caption={block.alt ? t('html.captionWithAlt', { alt: block.alt }) : t('html.caption')} actions={ready && <><Button size="icon-xs" variant="ghost" title={t('html.fullscreen')} aria-label={t('html.fullscreen')} onClick={() => setLarge(true)}><Maximize2 /></Button><Button size="icon-xs" variant="ghost" title={t('html.exportHtml')} aria-label={t('html.exportHtml')} onClick={() => { exportDocument(block, cdn, theme, title); toast.success(t('visualization.exported')); }}><Download /></Button></>}>
      {body}
    </VisualFrame>
    {ready && <Dialog open={large} onOpenChange={setLarge}><DialogContent data-assistant-floating className="max-w-[min(1100px,calc(100vw-2rem))]"><DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription className="sr-only">{t('html.fullscreenDescription')}</DialogDescription></DialogHeader>{large && <HtmlFrame block={block} cdn={cdn} theme={theme} title={title} maxHeight={Math.round(window.innerHeight * 0.8)} />}</DialogContent></Dialog>}
  </div>;
});
