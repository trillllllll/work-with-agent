/** Monday 00:00 through the next Monday 00:00 in the browser's local time zone. */
export function weekRange(now: Date, offsetWeeks = 0) {
  const day = now.getDay();
  const mondayDelta = (day === 0 ? -6 : 1 - day) + offsetWeeks * 7;
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayDelta, 0, 0, 0, 0);
  const to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 7, 0, 0, 0, 0);
  return { from, to };
}

/** Inclusive calendar dates (`yyyy-mm-dd`) as a half-open local range [from 00:00, to+1 00:00). */
export function customRange(fromDate: string, toDate: string) {
  const from = dateAtMidnight(fromDate);
  const end = dateAtMidnight(toDate);
  if (!from || !end) return null;
  const to = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1, 0, 0, 0, 0);
  if (to.getTime() <= from.getTime()) return null;
  return { from, to };
}

export function dateInputValue(date: Date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function dateAtMidnight(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day, 0, 0, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}
