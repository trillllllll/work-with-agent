import { prisma } from '../infrastructure/prisma.js';
import { coordinatorWork } from './coordinator-work.js';
import { publishWorkspaceChange } from './workspace-events.js';
import { calendarFormatter, localCalendarDate, scheduledInstant, shiftCalendarDate } from './reviews-clock.js';
import { reminderSettings } from './reminder-settings.js';
import { sendPushToAll } from './push-subscriptions.js';

const TICK_MS = 30_000;
// A regular tick covers jitter between rounds; the first tick after a restart looks a bit further back.
const WINDOW_MS = 90_000;
const CATCHUP_MS = 2 * 60 * 60 * 1000;
const FIRE_RETENTION_DAYS = 30;
// The largest lead is 30 days, so an anchor older than a month can never arm again.
const ANCHOR_LOOKBACK_DAYS = 31;

let timer: NodeJS.Timeout | null = null;
let busy = false;
let firstTick = true;
let lastCleanupDate = '';

export type ReminderScheduleInput = { scheduledStart?: string | null; dueDate?: string | null; reminderMinutesBefore?: number | null };
export type ReminderSettingsInput = { leadMinutes: number; allDayTime: string; timeZone: string };

/**
 * When the reminder for a task fires. Tasks store floating local wall times, so the anchor
 * resolves through the workspace time zone (DST-safe). `null` follows the global default;
 * `-1` means the task opted out; a task with neither start nor date has nothing to remind about.
 */
export function reminderFireAt(task: ReminderScheduleInput, settings: ReminderSettingsInput): { at: Date; anchor: Date; lead: number } | null {
  if (task.reminderMinutesBefore === -1) return null;
  const start = task.scheduledStart ?? null;
  const anchorDate = start ? start.slice(0, 10) : task.dueDate ?? null;
  if (!anchorDate || !/^\d{4}-\d{2}-\d{2}$/.test(anchorDate)) return null;
  const anchorTime = start ? start.slice(11, 16) : settings.allDayTime;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(anchorTime)) return null;
  let anchor: Date;
  try {
    anchor = scheduledInstant(anchorDate, anchorTime, settings.timeZone);
  } catch {
    return null; // A wall time that does not exist in this zone (DST gap) cannot arm.
  }
  const lead = task.reminderMinutesBefore ?? settings.leadMinutes;
  return { at: new Date(anchor.getTime() - lead * 60_000), anchor, lead };
}

/**
 * Fires every reminder whose time has entered the window. Each fire is recorded under
 * `${anchorInstant}:${lead}` first; the unique index makes repeated ticks and concurrent
 * runs idempotent, and a rescheduled or re-tiered task simply arms under a new key.
 */
export async function fireDueReminders(now = new Date(), windowMs = firstTick ? CATCHUP_MS : WINDOW_MS) {
  const settings = await reminderSettings();
  const format = calendarFormatter(settings.timeZone);
  const nowMs = now.getTime();
  const cutoff = shiftCalendarDate(localCalendarDate(now, settings.timeZone, format), -ANCHOR_LOOKBACK_DAYS);
  const tasks = await prisma.task.findMany({
    where: {
      deletedAt: null,
      status: { not: 'done' },
      AND: [
        { OR: [{ reminderMinutesBefore: null }, { reminderMinutesBefore: { not: -1 } }] },
        { OR: [{ topicId: null }, { topic: { archivedAt: null } }] },
        { OR: [
          { scheduledStart: { not: null, gte: `${cutoff}T00:00` } },
          { scheduledStart: null, dueDate: { not: null, gte: cutoff } },
        ] },
      ],
    },
    select: { id: true, title: true, scheduledStart: true, dueDate: true, reminderMinutesBefore: true },
  });
  const fired: Array<{ taskId: string; title: string; anchor: Date; lead: number }> = [];
  for (const task of tasks) {
    const fire = reminderFireAt(task, settings);
    if (!fire) continue;
    const atMs = fire.at.getTime();
    if (atMs < nowMs - windowMs || atMs > nowMs) continue;
    // A task that already started (beyond the regular jitter window) is not replayed after a restart.
    if (fire.anchor.getTime() < nowMs - WINDOW_MS) continue;
    try {
      await prisma.reminderFire.create({ data: { taskId: task.id, fireKey: `${fire.anchor.toISOString()}:${fire.lead}`, firedAt: now.toISOString() } });
    } catch (error) {
      if (!((error as { code?: string }).code === 'P2002')) throw error;
      continue; // Already fired for this anchor and lead.
    }
    fired.push({ taskId: task.id, title: task.title, anchor: fire.anchor, lead: fire.lead });
  }
  if (fired.length) {
    publishWorkspaceChange({
      kind: 'reminder',
      batchId: `reminder:${now.toISOString()}`,
      tasks: fired.map(({ taskId, title, anchor }) => ({ taskId, title, scheduledAt: anchor.toISOString() })),
    });
    const [first] = fired;
    const leadText = first.lead > 0 ? `${first.lead >= 1440 ? `${first.lead / 1440} 天` : `${first.lead} 分钟`}后` : '';
    await sendPushToAll({
      title: '任务提醒',
      body: fired.length === 1 ? `${first.title}${leadText ? ` · ${leadText}` : ''}` : `${fired.length} 个任务到了提醒时间：${fired.slice(0, 3).map(({ title }) => title).join('、')}${fired.length > 3 ? ' 等' : ''}`,
      url: '/',
      tag: 'dovun-reminder',
    });
  }
  // One cleanup pass per local day: reminder rows older than the retention window go away.
  const today = localCalendarDate(now, settings.timeZone, format);
  if (today !== lastCleanupDate) {
    lastCleanupDate = today;
    const horizon = new Date(nowMs - FIRE_RETENTION_DAYS * 86_400_000).toISOString();
    await prisma.reminderFire.deleteMany({ where: { firedAt: { lt: horizon } } });
  }
  return fired;
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    await coordinatorWork(() => fireDueReminders());
    firstTick = false;
  } catch (error) {
    console.error('提醒调度失败：', error);
  } finally {
    busy = false;
  }
}

/** Minute-interval style loop following the review scheduler pattern; returns the stop function. */
export function startReminderScheduler() {
  if (timer) return () => stopReminderScheduler();
  void tick();
  timer = setInterval(() => void tick(), TICK_MS);
  timer.unref();
  return () => stopReminderScheduler();
}

export function stopReminderScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
