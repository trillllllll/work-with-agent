import { z } from 'zod';
import { DomainError } from '../domain/task.js';
import { prisma } from '../infrastructure/prisma.js';

const colors = ['blue', 'green', 'orange', 'purple', 'pink', 'gray'] as const;
export type TimeBandColor = (typeof colors)[number];
export type PlanTimeBand = {
  id: string;
  name: string;
  startMinute: number;
  endMinute: number;
  weekdays: number[];
  color: TimeBandColor;
};

const bandSchema = z.object({
  id: z.string().uuid(),
  name: z.string().superRefine((value, ctx) => {
    const length = value.trim().length;
    if (length < 1 || length > 40) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '名称须为 1–40 个字符' });
  }),
  startMinute: z.number().int().min(0).max(1439),
  endMinute: z.number().int().min(1).max(1440),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).superRefine((days, ctx) => {
    if (new Set(days).size !== days.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '星期不能重复' });
  }),
  color: z.enum(colors),
}).strict().superRefine((band, ctx) => {
  if (band.endMinute <= band.startMinute) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endMinute'], message: '结束时间必须晚于开始时间' });
});

const payloadSchema = z.object({
  bands: z.array(bandSchema).max(100),
}).strict().superRefine((payload, ctx) => {
  const ids = payload.bands.map((band) => band.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['bands'], message: '时间段 ID 重复' });
});

function toBand(row: { id: string; name: string; startMinute: number; endMinute: number; weekdaysJson: string; color: string }): PlanTimeBand {
  return {
    id: row.id,
    name: row.name,
    startMinute: row.startMinute,
    endMinute: row.endMinute,
    weekdays: JSON.parse(row.weekdaysJson) as number[],
    color: row.color as TimeBandColor,
  };
}

export async function listPlanTimeBands() {
  const rows = await prisma.planTimeBand.findMany({ orderBy: { position: 'asc' } });
  return { bands: rows.map(toBand) };
}

export const PLAN_TIME_BAND_NOTE = '已保存的时间段就是当前生效的。星期 1–7 表示周一到周日。结束时刻不包含在段内。重叠时每条都算命中。名称由用户设定，没有单独的上班或休息类型。空列表表示当前没有规划时间段。';

export type PlanTimeBandView = PlanTimeBand & { start: string; end: string };
export type PlanTimeBandInstant = { localDateTime: string; weekday: number; minute: number; matches: PlanTimeBandView[] };
export type PlanTimeBandRead = { bands: PlanTimeBandView[]; empty: boolean; note: string; at?: PlanTimeBandInstant };

function formatMinute(minute: number) {
  if (minute === 1440) return '24:00';
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

export function toPlanTimeBandView(band: PlanTimeBand): PlanTimeBandView {
  return { ...band, start: formatMinute(band.startMinute), end: formatMinute(band.endMinute) };
}

const atPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export function parsePlanTimeBandInstant(at: string) {
  const match = atPattern.exec(at);
  if (!match) throw new DomainError('INVALID_INPUT', 'at 须为 YYYY-MM-DDTHH:mm', 400);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59) throw new DomainError('INVALID_INPUT', 'at 须为 YYYY-MM-DDTHH:mm', 400);
  const date = new Date(year, month - 1, day, 12, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) throw new DomainError('INVALID_INPUT', 'at 须为 YYYY-MM-DDTHH:mm', 400);
  return { localDateTime: at, weekday: date.getDay() === 0 ? 7 : date.getDay(), minute: hour * 60 + minute };
}

export function matchPlanTimeBands(bands: readonly PlanTimeBand[], at: string): PlanTimeBandInstant {
  const instant = parsePlanTimeBandInstant(at);
  const matches = bands.filter((band) => band.weekdays.includes(instant.weekday) && band.startMinute <= instant.minute && instant.minute < band.endMinute).map(toPlanTimeBandView);
  return { ...instant, matches };
}

export function presentPlanTimeBands(bands: readonly PlanTimeBand[], at?: string): PlanTimeBandRead {
  const views = bands.map(toPlanTimeBandView);
  return { bands: views, empty: views.length === 0, note: PLAN_TIME_BAND_NOTE, ...(at === undefined ? {} : { at: matchPlanTimeBands(bands, at) }) };
}

export function planTimeBandPrompt(read: PlanTimeBandRead) {
  if (read.empty) return `【规划时间段】\n当前没有已保存的规划时间段。\n${read.note}`;
  const lines = read.bands.map((band) => `- ${band.name} ${band.start}–${band.end} 星期 ${band.weekdays.join(',')} 颜色 ${band.color}`);
  return `【规划时间段】\n${read.note}\n${lines.join('\n')}`;
}

export async function readPlanTimeBands(at?: string) {
  const { bands } = await listPlanTimeBands();
  return presentPlanTimeBands(bands, at);
}

export async function replacePlanTimeBands(payload: unknown) {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) throw parsed.error;
  const normalized = parsed.data.bands.map((band, position) => ({
    id: band.id,
    name: band.name.trim(),
    startMinute: band.startMinute,
    endMinute: band.endMinute,
    weekdaysJson: JSON.stringify([...band.weekdays].sort((left, right) => left - right)),
    color: band.color,
    position,
  }));
  const rows = await prisma.$transaction(async (tx) => {
    await tx.planTimeBand.deleteMany();
    if (normalized.length) await tx.planTimeBand.createMany({ data: normalized });
    return tx.planTimeBand.findMany({ orderBy: { position: 'asc' } });
  });
  return { bands: rows.map(toBand) };
}
