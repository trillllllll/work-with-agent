import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ContextUsage } from '@/lib/context-usage.js';
import { ContextUsageRing } from './ContextUsageRing.js';

const stats = (estimatedInputTokens: number, contextWindow: number | null) => ({ estimatedInputTokens, contextWindow }) as ContextUsage;

describe('context usage ring', () => {
  it('shows only a token count without a configured window', () => {
    const html = renderToStaticMarkup(<ContextUsageRing stats={stats(1200, null)} />);
    expect(html).toContain('>1.2k</text>');
    expect(html).not.toContain('context-usage-ring-arc');
    expect(html).not.toContain('%</text>');
  });

  it('starts at zero without a colored arc', () => {
    const html = renderToStaticMarkup(<ContextUsageRing stats={stats(0, 100)} />);
    expect(html).toContain('>0%</text>');
    expect(html).not.toContain('context-usage-ring-arc');
  });

  it('draws clockwise from twelve and clamps only the overflow arc', () => {
    const middle = renderToStaticMarkup(<ContextUsageRing stats={stats(50, 100)} />);
    expect(middle).toContain('transform="rotate(-90 18 18)"');
    expect(middle).toContain('stroke-dashoffset="47.12388980384689"');
    expect(middle).toContain('>50%</text>');
    const full = renderToStaticMarkup(<ContextUsageRing stats={stats(100, 100)} />);
    expect(full).toContain('stroke-dashoffset="0"');
    const overflow = renderToStaticMarkup(<ContextUsageRing stats={stats(120, 100)} />);
    expect(overflow).toContain('stroke-dashoffset="0"');
    expect(overflow).toContain('>120%</text>');
    expect(overflow).toContain('text-destructive');
  });
});
