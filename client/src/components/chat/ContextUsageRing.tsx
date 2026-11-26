import { compactTokens, usageLevel, windowPercent, type ContextUsage } from '@/lib/context-usage.js';
import { cn } from '@/lib/utils.js';

const radius = 15;
const circumference = 2 * Math.PI * radius;
const levelText = { normal: 'text-primary', high: 'text-warning', full: 'text-destructive' } as const;

export function ContextUsageRing({ stats }: { stats: ContextUsage | null }) {
  const percent = stats ? windowPercent(stats) : null;
  const level = usageLevel(percent);
  const arc = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  const label = stats ? percent === null ? compactTokens(stats.estimatedInputTokens) : `${Math.round(percent)}%` : '—';
  return <svg data-testid="context-usage-ring" data-percent={percent ?? undefined} data-window={stats?.contextWindow ?? undefined} className={cn('size-8 shrink-0', percent === null ? 'text-muted-foreground' : levelText[level])} viewBox="0 0 36 36" aria-hidden="true">
    <circle cx="18" cy="18" r={radius} fill="none" stroke="var(--muted-foreground)" strokeOpacity="0.25" strokeWidth="3" />
    {arc > 0 && <circle data-testid="context-usage-ring-arc" cx="18" cy="18" r={radius} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - arc / 100)} transform="rotate(-90 18 18)" />}
    <text x="18" y="18" textAnchor="middle" dominantBaseline="central" fill="currentColor" fontSize={label.length > 4 ? 7.5 : 9} fontWeight="600">{label}</text>
  </svg>;
}
