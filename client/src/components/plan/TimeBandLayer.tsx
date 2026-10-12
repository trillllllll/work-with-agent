import type { CSSProperties } from 'react';
import type { PlanTimeBand, TimeBandColor } from '@/lib/api.js';
import { isoWeekday, resolveTimeBandSegments, timeBandGeometry, timeBandSegmentLabels } from '@/lib/plan-time-bands.js';

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

export function TimeBandLayer({ bands, dateKey }: { bands: readonly PlanTimeBand[]; dateKey: string }) {
  const segments = resolveTimeBandSegments(bands, isoWeekday(dateKey));
  const labels = timeBandSegmentLabels(bands, segments);
  return <div data-testid="time-band-layer" className="pointer-events-none absolute inset-0 z-0">
    {segments.map((segment, index) => {
      const geometry = timeBandGeometry(segment);
      const label = labels[index];
      return <div key={`${segment.bandId}:${segment.startMinute}:${segment.endMinute}`} data-testid="time-band-segment" data-band-id={segment.bandId} data-start-minute={segment.startMinute} data-end-minute={segment.endMinute} data-color={segment.color} className="absolute overflow-hidden" style={segmentStyle(segment.color, geometry.top, geometry.height)}>
        {label && <span className="absolute overflow-hidden text-ellipsis whitespace-nowrap" style={{ top: 2, left: 0, right: 0, paddingLeft: 6, paddingRight: 6, fontSize: 11, lineHeight: '16px', fontWeight: 500, pointerEvents: 'none' }}>{label}</span>}
      </div>;
    })}
  </div>;
}
