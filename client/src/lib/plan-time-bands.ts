import type { PlanTimeBand, TimeBandSegment } from './api.js';

export function isoWeekday(dateKey: string) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(year, month - 1, day, 12, 0, 0);
  const jsDay = date.getDay();
  return jsDay === 0 ? 7 : jsDay;
}

export function resolveTimeBandSegments(bands: readonly PlanTimeBand[], weekday: number): TimeBandSegment[] {
  const active = bands
    .map((band, index) => ({ band, index }))
    .filter(({ band }) => band.weekdays.includes(weekday));
  if (!active.length) return [];
  const boundaries = [...new Set(active.flatMap(({ band }) => [band.startMinute, band.endMinute]))].sort((left, right) => left - right);
  const result: TimeBandSegment[] = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const startMinute = boundaries[index];
    const endMinute = boundaries[index + 1];
    const candidates = active.filter(({ band }) => band.startMinute <= startMinute && band.endMinute >= endMinute);
    if (!candidates.length) continue;
    const winner = [...candidates].sort((left, right) => {
      const duration = (left.band.endMinute - left.band.startMinute) - (right.band.endMinute - right.band.startMinute);
      return duration || right.index - left.index;
    })[0];
    const previous = result[result.length - 1];
    if (previous && previous.bandId === winner.band.id && previous.endMinute === startMinute) previous.endMinute = endMinute;
    else result.push({ bandId: winner.band.id, startMinute, endMinute, color: winner.band.color });
  }
  return result;
}

export function timeBandGeometry(segment: Pick<TimeBandSegment, 'startMinute' | 'endMinute'>) {
  return {
    top: segment.startMinute * 56 / 60,
    height: (segment.endMinute - segment.startMinute) * 56 / 60,
  };
}

export function formatMinuteLabel(minute: number) {
  if (minute === 1440) return '24:00';
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

export function timeBandLabel(band: Pick<PlanTimeBand, 'name' | 'startMinute' | 'endMinute'>) {
  return `${band.name} ${formatMinuteLabel(band.startMinute)}–${formatMinuteLabel(band.endMinute)}`;
}

export function timeBandSegmentLabels(bands: readonly PlanTimeBand[], segments: readonly TimeBandSegment[]) {
  const byId = new Map(bands.map((band) => [band.id, band]));
  const shown = new Set<string>();
  const labels = segments.map(() => null as string | null);
  const ordered = segments.map((segment, index) => ({ segment, index })).sort((left, right) => left.segment.startMinute - right.segment.startMinute || left.index - right.index);
  for (const { segment, index } of ordered) {
    if (shown.has(segment.bandId) || timeBandGeometry(segment).height < 20) continue;
    shown.add(segment.bandId);
    const band = byId.get(segment.bandId);
    labels[index] = band ? timeBandLabel(band) : null;
  }
  return labels;
}

const clock = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseStartMinute(value: string) {
  const match = clock.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function parseEndMinute(value: string) {
  if (value === '24:00') return 1440;
  const match = clock.exec(value);
  if (!match) return null;
  const minute = Number(match[1]) * 60 + Number(match[2]);
  return minute >= 1 ? minute : null;
}
