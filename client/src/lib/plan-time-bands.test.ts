import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  formatMinuteLabel,
  isoWeekday,
  planTimeline,
  planTimelineMinWidth,
  resolveTimeBandSegments,
  timeBandGeometry,
  timeBandLabelMode,
  timeBandSegmentLabels,
} from './plan-time-bands.js';
import type { PlanTimeBand } from './api.js';

const work: PlanTimeBand = {
  id: '00000000-0000-4000-8000-000000000001',
  name: '工作',
  startMinute: 540,
  endMinute: 1080,
  weekdays: [1, 2, 3, 4, 5],
  color: 'blue',
};

const lunch: PlanTimeBand = {
  id: '00000000-0000-4000-8000-000000000002',
  name: '午休',
  startMinute: 720,
  endMinute: 780,
  weekdays: [1, 2, 3, 4, 5],
  color: 'green',
};

describe('时间段背景', () => {
  it('短时间段覆盖大时间段，并恢复后续背景', () => {
    expect(resolveTimeBandSegments([work, lunch], 1)).toEqual([
      { bandId: work.id, startMinute: 540, endMinute: 720, color: 'blue' },
      { bandId: lunch.id, startMinute: 720, endMinute: 780, color: 'green' },
      { bandId: work.id, startMinute: 780, endMinute: 1080, color: 'blue' },
    ]);
  });

  it('相同时长后面的记录优先', () => {
    const later = { ...work, id: lunch.id, color: 'green' as const };
    expect(resolveTimeBandSegments([work, later], 1)).toEqual([
      { bandId: later.id, startMinute: 540, endMinute: 1080, color: 'green' },
    ]);
  });

  it('不在重复星期内不显示', () => {
    expect(resolveTimeBandSegments([work, lunch], 7)).toEqual([]);
  });

  it('相邻边界不重叠，不合并不同 ID', () => {
    const a = { ...work, endMinute: 720 };
    const b = { ...lunch, color: 'blue' as const };
    expect(resolveTimeBandSegments([a, b], 1)).toEqual([
      { bandId: a.id, startMinute: 540, endMinute: 720, color: 'blue' },
      { bandId: b.id, startMinute: 720, endMinute: 780, color: 'blue' },
    ]);
  });

  it('保留分钟级小数像素', () => {
    const result = timeBandGeometry({ startMinute: 541, endMinute: 542 });
    expect(result.top).toBeCloseTo(504.9333333333333, 8);
    expect(result.height).toBeCloseTo(0.9333333333333, 8);
  });

  it('完整工作时间位置精确', () => {
    expect(timeBandGeometry(work)).toEqual({ top: 504, height: 504 });
    expect(timeBandGeometry({ startMinute: 0, endMinute: 1440 }))
      .toEqual({ top: 0, height: 1344 });
  });

  it('不修改输入', () => {
    const input = [structuredClone(work), structuredClone(lunch)];
    const before = structuredClone(input);
    resolveTimeBandSegments(input, 1);
    expect(input).toEqual(before);
  });

  it('空数组没有背景', () => {
    expect(resolveTimeBandSegments([], 1)).toEqual([]);
  });

  it('三层嵌套按原始时长取最短', () => {
    const mid: PlanTimeBand = { ...lunch, id: '00000000-0000-4000-8000-000000000003', name: '上午', startMinute: 600, endMinute: 900, color: 'orange' };
    const inner: PlanTimeBand = { ...lunch, id: '00000000-0000-4000-8000-000000000004', name: '短会', startMinute: 660, endMinute: 690, color: 'pink' };
    expect(resolveTimeBandSegments([work, mid, inner], 1)).toEqual([
      { bandId: work.id, startMinute: 540, endMinute: 600, color: 'blue' },
      { bandId: mid.id, startMinute: 600, endMinute: 660, color: 'orange' },
      { bandId: inner.id, startMinute: 660, endMinute: 690, color: 'pink' },
      { bandId: mid.id, startMinute: 690, endMinute: 900, color: 'orange' },
      { bandId: work.id, startMinute: 900, endMinute: 1080, color: 'blue' },
    ]);
  });

  it('部分重叠只替换相交区间', () => {
    const morning: PlanTimeBand = { ...work, endMinute: 800 };
    const overlap: PlanTimeBand = { ...lunch, startMinute: 700, endMinute: 900, color: 'orange' };
    expect(resolveTimeBandSegments([morning, overlap], 1)).toEqual([
      { bandId: morning.id, startMinute: 540, endMinute: 700, color: 'blue' },
      { bandId: overlap.id, startMinute: 700, endMinute: 900, color: 'orange' },
    ]);
  });

  it('完全被相同时长的后一条覆盖时不留片段', () => {
    const covered: PlanTimeBand = { ...work, id: '00000000-0000-4000-8000-000000000005', startMinute: 600, endMinute: 700 };
    const cover: PlanTimeBand = { ...lunch, id: '00000000-0000-4000-8000-000000000006', startMinute: 600, endMinute: 700, color: 'orange' };
    expect(resolveTimeBandSegments([covered, cover], 1)).toEqual([
      { bandId: cover.id, startMinute: 600, endMinute: 700, color: 'orange' },
    ]);
  });

  it('优先级使用原始时长，不用裁切后的长度', () => {
    const early: PlanTimeBand = { ...work, id: '00000000-0000-4000-8000-000000000007', startMinute: 0, endMinute: 100 };
    const wide: PlanTimeBand = { ...work, id: '00000000-0000-4000-8000-000000000008', startMinute: 50, endMinute: 200, color: 'green' };
    const brief: PlanTimeBand = { ...work, id: '00000000-0000-4000-8000-000000000009', startMinute: 80, endMinute: 120, color: 'orange' };
    expect(resolveTimeBandSegments([early, wide, brief], 1)).toEqual([
      { bandId: early.id, startMinute: 0, endMinute: 80, color: 'blue' },
      { bandId: brief.id, startMinute: 80, endMinute: 120, color: 'orange' },
      { bandId: wide.id, startMinute: 120, endMinute: 200, color: 'green' },
    ]);
  });

  it('标签只出现在该时间段第一段足够高的可见片段', () => {
    const segments = resolveTimeBandSegments([work, lunch], 1);
    expect(timeBandSegmentLabels([work, lunch], segments)).toEqual([
      { name: '工作', range: '09:00–18:00', text: '工作 09:00–18:00' },
      { name: '午休', range: '12:00–13:00', text: '午休 12:00–13:00' },
      null,
    ]);
    const short: PlanTimeBand = { ...work, id: '00000000-0000-4000-8000-00000000000a', name: '短', startMinute: 0, endMinute: 21 };
    const tall: PlanTimeBand = { ...work, id: '00000000-0000-4000-8000-00000000000b', name: '够高', startMinute: 100, endMinute: 122 };
    expect(timeBandGeometry(short).height).toBeLessThan(20);
    expect(timeBandGeometry({ startMinute: 100, endMinute: 122 }).height).toBeGreaterThanOrEqual(20);
    expect(timeBandGeometry({ startMinute: 100, endMinute: 122 }).height).toBeLessThan(36);
    expect(timeBandSegmentLabels([short, tall], resolveTimeBandSegments([short, tall], 1))).toEqual([
      null,
      { name: '够高', range: null, text: '够高 01:40–02:02' },
    ]);
    const covered: PlanTimeBand = { ...work, name: '被盖住' };
    const cover: PlanTimeBand = { ...work, id: lunch.id, name: '盖住', color: 'green' };
    expect(timeBandSegmentLabels([covered, cover], resolveTimeBandSegments([covered, cover], 1))).toEqual([
      { name: '盖住', range: '09:00–18:00', text: '盖住 09:00–18:00' },
    ]);
  });

  it('可见高度决定两行、仅名称或不显示，去重不升级后面的片段', () => {
    expect(timeBandLabelMode(19.999)).toBe('hidden');
    expect(timeBandLabelMode(20)).toBe('name');
    expect(timeBandLabelMode(35)).toBe('name');
    expect(timeBandLabelMode(35.999)).toBe('name');
    expect(timeBandLabelMode(36)).toBe('both');
    const nameOnly: PlanTimeBand = { ...work, id: '00000000-0000-4000-8000-00000000000c', name: '只看名称', startMinute: 0, endMinute: 38 };
    expect(timeBandGeometry(nameOnly).height).toBeGreaterThanOrEqual(20);
    expect(timeBandGeometry(nameOnly).height).toBeLessThan(36);
    expect(timeBandSegmentLabels([nameOnly], resolveTimeBandSegments([nameOnly], 1))).toEqual([
      { name: '只看名称', range: null, text: '只看名称 00:00–00:38' },
    ]);
    const both: PlanTimeBand = { ...work, id: '00000000-0000-4000-8000-00000000000d', name: '两行', startMinute: 100, endMinute: 139 };
    expect(timeBandGeometry(both).height).toBeGreaterThanOrEqual(36);
    expect(timeBandSegmentLabels([both], resolveTimeBandSegments([both], 1))).toEqual([
      { name: '两行', range: '01:40–02:19', text: '两行 01:40–02:19' },
    ]);
    const outer: PlanTimeBand = { ...work, id: '00000000-0000-4000-8000-00000000000e', name: '外层', startMinute: 0, endMinute: 180 };
    const bite: PlanTimeBand = { ...lunch, id: '00000000-0000-4000-8000-00000000000f', name: '咬掉', startMinute: 22, endMinute: 40, color: 'orange' };
    const split = resolveTimeBandSegments([outer, bite], 1);
    expect(split.map((segment) => [segment.bandId, segment.startMinute, segment.endMinute])).toEqual([
      [outer.id, 0, 22],
      [bite.id, 22, 40],
      [outer.id, 40, 180],
    ]);
    expect(timeBandGeometry(split[0]).height).toBeLessThan(36);
    expect(timeBandGeometry(split[2]).height).toBeGreaterThanOrEqual(36);
    expect(timeBandSegmentLabels([outer, bite], split)).toEqual([
      { name: '外层', range: null, text: '外层 00:00–03:00' },
      null,
      null,
    ]);
    const cap: PlanTimeBand = { ...lunch, id: '00000000-0000-4000-8000-000000000010', name: '帽', startMinute: 0, endMinute: 15, color: 'pink' };
    const later = resolveTimeBandSegments([outer, cap], 1);
    expect(timeBandLabelMode(timeBandGeometry(later[0]).height)).toBe('hidden');
    expect(timeBandSegmentLabels([outer, cap], later)[1]).toEqual({ name: '外层', range: '00:00–03:00', text: '外层 00:00–03:00' });
  });

  it('周视图有时间段时为侧栏和任务区预留宽度', () => {
    expect(planTimeline).toEqual({ hourGutter: 48, weekMin: 760, railDay: 112, railCompact: 80 });
    expect(planTimelineMinWidth(7)).toBe(760);
    expect(planTimelineMinWidth(1)).toBeUndefined();
    const css = readFileSync(fileURLToPath(new URL('../index.css', import.meta.url)), 'utf8');
    expect(css).toContain(`--plan-band-rail: ${planTimeline.railDay}px`);
    expect(css).toContain(`--plan-band-rail: ${planTimeline.railCompact}px`);
    expect(css).toContain('max-width: 639px');
    expect(css).toContain('.plan-calendar.plan-calendar-week');
  });

  it('24:00 标签使用结束分钟原文', () => {
    expect(formatMinuteLabel(1440)).toBe('24:00');
    expect(formatMinuteLabel(0)).toBe('00:00');
  });

  it('本地星期按显示日计算，不随系统时区漂移', () => {
    const clientRoot = fileURLToPath(new URL('../../', import.meta.url));
    const weekday = (timeZone: string, dateKey: string) => Number(execFileSync(process.execPath, [
      '--import', 'tsx',
      '--input-type=module',
      '-e',
      `import bands from './src/lib/plan-time-bands.ts'; process.stdout.write(String(bands.isoWeekday(${JSON.stringify(dateKey)})));`,
    ], { cwd: clientRoot, env: { ...process.env, TZ: timeZone }, encoding: 'utf8' }));
    for (const timeZone of ['Asia/Shanghai', 'America/Los_Angeles', 'Pacific/Auckland', 'Pacific/Kiritimati', 'Etc/GMT+12']) {
      expect(weekday(timeZone, '2026-10-12')).toBe(1);
      expect(weekday(timeZone, '2026-10-17')).toBe(6);
      expect(weekday(timeZone, '2026-10-18')).toBe(7);
    }
    expect(isoWeekday('2026-10-12')).toBe(1);
  });
});
