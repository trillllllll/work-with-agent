import type { CSSProperties } from 'react';
import type { PlanTimeBand, TimeBandColor } from '@/lib/api.js';
import { isoWeekday, resolveTimeBandSegments, timeBandGeometry, timeBandSegmentLabels, type TimeBandSegmentLabel } from '@/lib/plan-time-bands.js';

function px(value: number) {
  return `${value}px`;
}

const segmentStyle = (color: TimeBandColor, top: number, height: number): CSSProperties => ({
  top: px(top),
  height: px(height),
  left: 0,
  right: 0,
  borderRadius: 0,
  border: 'none',
  backgroundColor: `var(--time-band-${color}-bg)`,
  color: `var(--time-band-${color}-fg)`,
  zIndex: 0,
  pointerEvents: 'none',
});

function BandLabel({ label }: { label: TimeBandSegmentLabel }) {
  return <span role="group" aria-label={label.text} data-testid="time-band-label" data-label-mode={label.range ? 'both' : 'name'} className="absolute overflow-hidden" style={{ top: 2, left: 0, width: 'var(--plan-band-rail, 112px)', paddingLeft: 6, paddingRight: 6, pointerEvents: 'none' }}>
    <span aria-hidden="true" data-testid="time-band-label-name" className="block overflow-hidden text-ellipsis whitespace-nowrap" style={{ fontSize: 11, lineHeight: '16px', fontWeight: 500 }}>{label.name}</span>
    {label.range && <span aria-hidden="true" data-testid="time-band-label-range" className="block overflow-hidden text-ellipsis whitespace-nowrap tabular-nums" style={{ fontSize: 10, lineHeight: '14px', fontWeight: 500 }}>{label.range}</span>}
  </span>;
}

export function TimeBandLayer({ bands, dateKey }: { bands: readonly PlanTimeBand[]; dateKey: string }) {
  const segments = resolveTimeBandSegments(bands, isoWeekday(dateKey));
  const labels = timeBandSegmentLabels(bands, segments);
  return <div data-testid="time-band-layer" className="pointer-events-none absolute inset-0 z-0">
    {segments.map((segment, index) => {
      const geometry = timeBandGeometry(segment);
      const label = labels[index];
      return <div key={`${segment.bandId}:${segment.startMinute}:${segment.endMinute}`} data-testid="time-band-segment" data-band-id={segment.bandId} data-start-minute={segment.startMinute} data-end-minute={segment.endMinute} data-color={segment.color} className="absolute overflow-hidden" style={segmentStyle(segment.color, geometry.top, geometry.height)}>
        {label && <BandLabel label={label} />}
      </div>;
    })}
  </div>;
}
