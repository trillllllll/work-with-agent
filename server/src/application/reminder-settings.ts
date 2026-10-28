import { prisma } from '../infrastructure/prisma.js';
import { DomainError } from '../domain/task.js';
import { defaultMobileNavigationJson } from '../domain/mobile-navigation.js';
import { assertTimeZone } from './reviews-clock.js';

export const DEFAULT_REMINDER_LEAD_MINUTES = 10;
export const DEFAULT_ALL_DAY_TIME = '09:00';
export const DEFAULT_REMINDER_TIME_ZONE = 'Asia/Shanghai';
export const REMINDER_LEAD_CHOICES = [0, 5, 10, 30, 60, 1440, 43200] as const;

export type ReminderSettings = { leadMinutes: number; allDayTime: string; timeZone: string; defaultLeadMinutes: number };

export async function reminderSettings(): Promise<ReminderSettings> {
  const row = await prisma.appSetting.findUnique({ where: { id: 'default' }, select: { reminderLeadMinutes: true, reminderAllDayTime: true, reminderTimeZone: true } });
  return {
    leadMinutes: row?.reminderLeadMinutes ?? DEFAULT_REMINDER_LEAD_MINUTES,
    allDayTime: row?.reminderAllDayTime ?? DEFAULT_ALL_DAY_TIME,
    timeZone: row?.reminderTimeZone ?? DEFAULT_REMINDER_TIME_ZONE,
    defaultLeadMinutes: DEFAULT_REMINDER_LEAD_MINUTES,
  };
}

const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function saveReminderSettings(patch: { leadMinutes?: number; allDayTime?: string; timeZone?: string }): Promise<ReminderSettings> {
  const current = await reminderSettings();
  const leadMinutes = patch.leadMinutes ?? current.leadMinutes;
  const allDayTime = patch.allDayTime ?? current.allDayTime;
  const timeZone = patch.timeZone ?? current.timeZone;
  if (!Number.isSafeInteger(leadMinutes) || leadMinutes < 0 || leadMinutes > 43200) throw new DomainError('INVALID_REMINDER_SETTINGS', '默认提前量必须是 0 到 43200 的分钟数', 400);
  if (!timePattern.test(allDayTime)) throw new DomainError('INVALID_REMINDER_SETTINGS', '全天提醒时刻必须是 HH:mm', 400);
  assertTimeZone(timeZone);
  const timestamp = new Date().toISOString();
  await prisma.appSetting.upsert({
    where: { id: 'default' },
    create: { id: 'default', mobileNavigationJson: defaultMobileNavigationJson, reminderLeadMinutes: leadMinutes, reminderAllDayTime: allDayTime, reminderTimeZone: timeZone, createdAt: timestamp, updatedAt: timestamp },
    update: { reminderLeadMinutes: leadMinutes, reminderAllDayTime: allDayTime, reminderTimeZone: timeZone, updatedAt: timestamp },
  });
  return reminderSettings();
}
