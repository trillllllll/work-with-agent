export function isTaskImageSrc(taskId: string, src: string | undefined | null) {
  if (!src || !taskId) return false;
  let url: URL;
  try { url = new URL(src, 'http://task-detail.local'); } catch { return false; }
  if (url.origin !== 'http://task-detail.local' || url.search || url.hash) return false;
  const parts = url.pathname.split('/');
  if (parts.length !== 6 || parts[1] !== 'api' || parts[2] !== 'tasks' || parts[4] !== 'images') return false;
  return decodeURIComponent(parts[3]) === taskId && /^[A-Za-z0-9_-]+$/.test(parts[5]);
}

export function spliceText(value: string, start: number, end: number, text: string) {
  const safeStart = Math.min(Math.max(start, 0), value.length);
  const safeEnd = Math.min(Math.max(end, safeStart), value.length);
  return { value: value.slice(0, safeStart) + text + value.slice(safeEnd), caret: safeStart + text.length };
}

export function codeFence(selected: string) {
  const fence = selected.includes('```') ? '````' : '```';
  return { text: `${fence}\n${selected}\n${fence}\n`, caret: fence.length + 1 + selected.length };
}

export function imageMarkdown(url: string) {
  const text = `![](${url})\n`;
  return { text, caret: text.length };
}
