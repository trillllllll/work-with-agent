/** Tick ceiling, date-axis thinning, and chart geometry. Presentation only; no DOM. */

export function niceCeiling(max: number, steps = 4): number {
  if (!Number.isFinite(max) || max <= 0 || steps <= 0) return Math.max(steps, 1);
  const rough = max / steps;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const residual = rough / magnitude;
  const nice = residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 2.5 ? 2.5 : residual <= 5 ? 5 : 10;
  return Number((nice * magnitude * steps).toPrecision(12));
}

/** Integer ticks stay integers. Fractional ticks keep one decimal. */
export function formatAxisTick(value: number): string {
  if (!Number.isFinite(value)) return '';
  const rounded = Math.round(value);
  if (Math.abs(value - rounded) < 1e-6) return String(rounded);
  return String(Math.round(value * 10) / 10);
}

/** One label per day up to 10 points. Longer ranges keep every 5th day plus the last day. */
export function axisLabelIndexes(count: number): number[] {
  if (count <= 0) return [];
  const step = count <= 10 ? 1 : 5;
  const indexes: number[] = [];
  for (let index = 0; index < count; index += step) indexes.push(index);
  if (indexes[indexes.length - 1] !== count - 1) indexes.push(count - 1);
  return indexes;
}

export function chartLayout(count: number) {
  const safe = Math.max(count, 1);
  const slot = safe <= 8 ? 72 : safe <= 16 ? 44 : 28;
  const padL = 36;
  const padR = 8;
  const padT = 12;
  const padB = 22;
  const height = 168;
  const plotW = safe * slot;
  const width = padL + plotW + padR;
  return { slot, padL, padR, padT, padB, height, width, plotW, plotH: height - padT - padB };
}

/** Align rows onto `dates`, filling a missing day with 0. */
export function valuesByDate<T extends { date: string }>(dates: readonly string[], rows: readonly T[], pick: (row: T) => number): number[] {
  const map = new Map(rows.map((row) => [row.date, pick(row)]));
  return dates.map((date) => map.get(date) ?? 0);
}
