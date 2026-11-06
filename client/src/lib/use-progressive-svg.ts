import { mermaidHasContent } from '../../../server/src/shared/mermaid-policy.js';
import { useEffect, useRef, useState } from 'react';
import { renderMermaid } from './mermaid-render.js';
import { safeSvg } from './safe-svg.js';
import { svgCandidate } from '../../../server/src/shared/streaming-markup.js';
import type { ContentBlock } from './message-blocks.js';

/** Keep the last safe image. A running render finishes before the newest candidate is taken. */
export function useProgressiveSvg(block: ContentBlock, dark: boolean) {
  const latest = useRef({ block, dark }); latest.current = { block, dark };
  const [result, setResult] = useState({ svg: '', error: '', complete: false, identity: '' });
  useEffect(() => {
    let disposed = false, busy = false, attempted = '';
    let inputSource = '', inputTheme = false, inputStatus = '';

    const tick = async () => {
      if (busy || disposed) return;
      const { block: current, dark: theme } = latest.current;
      if (!['mermaid', 'svg'].includes(current.type) || !current.source) return;
      if (inputSource === current.source && inputTheme === theme && inputStatus === current.status) return;
      inputSource = current.source; inputTheme = theme; inputStatus = current.status;
      const final = current.status === 'ready';
      busy = true;
      try {
        const source = final ? current.source : current.type === 'svg' ? svgCandidate(current.source) : current.source.slice(0, current.source.lastIndexOf('\n') + 1);
        const identity = JSON.stringify([source, theme, final]);
        if (!source || attempted === identity) return;
        if (current.type === 'mermaid' && !mermaidHasContent(source)) {
          if (final) throw new Error('Empty Mermaid diagram');
          return;
        }
        attempted = identity;
        const svg = current.type === 'svg' ? safeSvg(source) : await renderMermaid(source, theme, true);
        if (!disposed) setResult({ svg, error: '', complete: final, identity: source });
      } catch (reason) {
        if (!disposed && final) setResult(old => ({ ...old, complete: false, error: reason instanceof Error ? reason.message : String(reason) }));
      } finally { busy = false; }
    };
    const timer = window.setInterval(() => void tick(), 160); void tick();
    return () => { disposed = true; window.clearInterval(timer); };
  }, [block.id, block.type]);
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!result.svg) return;
    const next = URL.createObjectURL(new Blob([result.svg], { type: 'image/svg+xml' })); setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [result.svg]);
  return { ...result, url, complete: block.status === 'ready' && result.complete && result.identity === block.source };
}
