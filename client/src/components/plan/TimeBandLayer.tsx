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

/** 该时段内是否有可见任务（含跨天续段）。空闲显示大标签，被占用退为左侧竖排小字。 */
function isOccupied(segment: { startMinute: number; endMinute: number }, occupied: ReadonlyArray<{ start: number; end: number }>) {
  return occupied.some((range) => range.start < segment.endMinute && range.end > segment.startMinute);
}

function BandLabel({ label, occupied }: { label: TimeBandSegmentLabel; occupied: boolean }) {
  if (occupied) {
    return <span role="group" aria-label={label.text} data-testid="time-band-label" data-band-state="occupied" className="plan-band-label-occupied"><span data-testid="time-band-label-name" className="block">{label.name}</span></span>;
  }
  return <span role="group" aria-label={label.text} data-testid="time-band-label" data-band-state="free" data-label-mode={label.range ? 'both' : 'name'} className="plan-band-label-free">
    <span aria-hidden="true" data-testid="time-band-label-name" className="plan-band-label-name">{label.name}</span>
    {label.range && <span aria-hidden="true" data-testid="time-band-label-range" className="plan-band-label-range tabular-nums">{label.range}</span>}
  </span>;
}

export function TimeBandLayer({ bands, dateKey, occupied = [] }: { bands: readonly PlanTimeBand[]; dateKey: string; occupied?: ReadonlyArray<{ start: number; end: number }> }) {
  const segments = resolveTimeBandSegments(bands, isoWeekday(dateKey));
  const labels = timeBandSegmentLabels(bands, segments);
  return <div data-testid="time-band-layer" className="pointer-events-none absolute inset-0 z-0">
    {segments.map((segment, index) => {
      const geometry = timeBandGeometry(segment);
      const label = labels[index];
      return <div key={`${segment.bandId}:${segment.startMinute}:${segment.endMinute}`} data-testid="time-band-segment" data-band-id={segment.bandId} data-start-minute={segment.startMinute} data-end-minute={segment.endMinute} data-color={segment.color} className="absolute overflow-hidden" style={segmentStyle(segment.color, geometry.top, geometry.height)}>
        {label && <BandLabel label={label} occupied={isOccupied(segment, occupied)} />}
      </div>;
    })}
  </div>;
}
