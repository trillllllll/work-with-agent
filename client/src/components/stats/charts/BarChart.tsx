import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Tooltip } from '@/components/ui/tooltip.js';
import { shortMonthDay } from '@/lib/stats-range.js';
import { axisLabelIndexes, chartLayout, niceCeiling } from './scale.js';

export type ColumnSeries = {
  id: string;
  values: number[];
  color: string;
  /** Hatched amount drawn on top of this series, in the same units. */
  hatch?: number[];
};

export type ColumnChartProps = {
  dates: string[];
  today?: string;
  series: ColumnSeries[];
  mode: 'stack' | 'group';
  line?: { values: number[]; color: string };
  ariaLabel: string;
  tooltip: (index: number) => string;
  tick: (value: number) => string;
};

export function ColumnChart({ dates, today, series, mode, line, ariaLabel, tooltip, tick }: ColumnChartProps) {
  const { t } = useTranslation('stats');
  const patternId = `hatch${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const layout = chartLayout(dates.length);
  const { padL, padR, padT, height, width, plotH, slot } = layout;
  const peakAt = (index: number) => {
    const lineValue = Math.max(0, line?.values[index] ?? 0);
    if (series.length === 0) return lineValue;
    if (mode === 'group') return Math.max(lineValue, ...series.map((item) => Math.max(0, item.values[index] ?? 0)));
    return Math.max(lineValue, series.reduce((sum, item) => sum + Math.max(0, item.values[index] ?? 0), 0));
  };
  const ceiling = niceCeiling(dates.reduce((peak, _, index) => Math.max(peak, peakAt(index)), 0) || 1);
  const yAt = (value: number) => padT + plotH * (1 - value / ceiling);
  const gap = 2;
  const barW = mode === 'group'
    ? Math.max(4, Math.min(22, (slot - 10 - gap * Math.max(0, series.length - 1)) / Math.max(series.length, 1)))
    : Math.min(26, slot * 0.52);
  const scroll = dates.length > 10;
  const labels = new Set(axisLabelIndexes(dates.length));

  return (
    <div className={scroll ? 'min-w-0 overflow-x-auto' : 'min-w-0'} data-testid="stats-chart-bar">
      <svg
        role="group"
        aria-label={ariaLabel}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        className="block h-auto w-full"
        style={{ aspectRatio: `${width} / ${height}`, minWidth: scroll ? width : undefined }}
      >
        <defs>
          <pattern id={patternId} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--foreground)" strokeOpacity="0.45" strokeWidth="2" />
          </pattern>
        </defs>
        {[0, 0.25, 0.5, 0.75, 1].map((step) => {
          const value = ceiling * step;
          const y = yAt(value);
          return (
            <g key={step}>
              <line x1={padL} x2={width - padR} y1={y} y2={y} stroke="var(--border)" strokeWidth="1" />
              <text x={padL - 4} y={y} textAnchor="end" dominantBaseline="middle" fill="var(--muted-foreground)" fontSize="10">{tick(value)}</text>
            </g>
          );
        })}
        {dates.map((date, index) => {
          const center = padL + index * slot + slot / 2;
          if (mode === 'stack') {
            let baseline = 0;
            return (
              <g key={date}>
                {series.map((item) => {
                  const value = Math.max(0, item.values[index] ?? 0);
                  const top = yAt(baseline + value);
                  const barH = yAt(baseline) - top;
                  const hatchValue = Math.min(value, Math.max(0, item.hatch?.[index] ?? 0));
                  const hatchH = (hatchValue / ceiling) * plotH;
                  baseline += value;
                  if (barH <= 0) return null;
                  return (
                    <g key={item.id}>
                      <rect x={center - barW / 2} y={top} width={barW} height={barH} rx={2} fill={item.color} />
                      {hatchH > 0 && <rect x={center - barW / 2} y={top} width={barW} height={Math.min(hatchH, barH)} rx={2} fill={`url(#${patternId})`} />}
                    </g>
                  );
                })}
              </g>
            );
          }
          const totalW = barW * series.length + gap * Math.max(0, series.length - 1);
          let x = center - totalW / 2;
          return (
            <g key={date}>
              {series.map((item) => {
                const value = Math.max(0, item.values[index] ?? 0);
                const barH = (value / ceiling) * plotH;
                const hatchValue = Math.min(value, Math.max(0, item.hatch?.[index] ?? 0));
                const hatchH = (hatchValue / ceiling) * plotH;
                const left = x;
                x += barW + gap;
                if (barH <= 0) return null;
                return (
                  <g key={item.id}>
                    <rect x={left} y={yAt(value)} width={barW} height={barH} rx={2} fill={item.color} />
                    {hatchH > 0 && <rect x={left} y={yAt(value)} width={barW} height={Math.min(hatchH, barH)} rx={2} fill={`url(#${patternId})`} />}
                  </g>
                );
              })}
            </g>
          );
        })}
        {line && (
          <polyline
            fill="none"
            stroke={line.color}
            strokeWidth="1.5"
            strokeDasharray="4 3"
            points={dates.map((_, index) => `${padL + index * slot + slot / 2},${yAt(Math.max(0, line.values[index] ?? 0))}`).join(' ')}
          />
        )}
        {dates.map((date, index) => labels.has(index) ? (
          <text
            key={date}
            x={padL + index * slot + slot / 2}
            y={height - 6}
            textAnchor="middle"
            fill={date === today ? 'var(--foreground)' : 'var(--muted-foreground)'}
            fontSize="10"
            fontWeight={date === today ? 600 : 400}
          >
            {shortMonthDay(date)}
          </text>
        ) : null)}
        {dates.map((date, index) => {
          const label = tooltip(index);
          return (
            <Tooltip key={`hit-${date}`} content={label}>
              <rect
                x={padL + index * slot}
                y={padT}
                width={slot}
                height={plotH}
                fill="transparent"
                tabIndex={0}
                aria-label={label}
                data-testid="stats-bar-hit"
                data-date={date}
              />
            </Tooltip>
          );
        })}
      </svg>
      {scroll && <p className="mt-1 text-xs text-muted-foreground lg:sr-only">{t('range.swipe')}</p>}
    </div>
  );
}

export function BarChart(props: Omit<ColumnChartProps, 'mode'>) {
  return <ColumnChart {...props} mode="stack" />;
}
