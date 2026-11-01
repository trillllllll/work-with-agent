/** M toggles the 学习主图 unless the user is typing or holding a modifier. */
export function isFigureShortcut(event: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; isComposing?: boolean; target?: EventTarget | null; repeat?: boolean }) {
  if (event.key !== 'm' && event.key !== 'M') return false;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.isComposing || event.repeat) return false;
  const target = event.target as { closest?: (selector: string) => unknown; isContentEditable?: boolean } | null;
  if (target?.isContentEditable) return false;
  if (typeof target?.closest === 'function' && target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]')) return false;
  return true;
}
