import { Tooltip } from '@/components/ui/tooltip.js';

export function LineChart({ values, ariaLabel, tooltip }: { values: number[]; ariaLabel: string; tooltip: (index: number) => string }) {
  const width = 180;
  const height = 44;
  const pad = 6;
  const max = Math.max(1, ...values.map((value) => Math.max(0, value)));
  const xAt = (index: number) => values.length <= 1 ? width / 2 : pad + (index / (values.length - 1)) * (width - pad * 2);
  const yAt = (value: number) => height - pad - (Math.max(0, value) / max) * (height - pad * 2);
  return (
    <svg role="group" aria-label={ariaLabel} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" className="h-11 w-full">
      <polyline fill="none" stroke="var(--tag-violet-fg)" strokeWidth="1.5" points={values.map((value, index) => `${xAt(index)},${yAt(value)}`).join(' ')} />
      {values.map((value, index) => {
        const label = tooltip(index);
        return (
          <g key={index}>
            <circle cx={xAt(index)} cy={yAt(value)} r="2" fill="var(--tag-violet-fg)" />
            <Tooltip content={label}>
              <circle cx={xAt(index)} cy={yAt(value)} r="7" fill="transparent" tabIndex={0} aria-label={label} />
            </Tooltip>
          </g>
        );
      })}
    </svg>
  );
}
