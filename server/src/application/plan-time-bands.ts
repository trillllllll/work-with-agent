import { z } from 'zod';
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
