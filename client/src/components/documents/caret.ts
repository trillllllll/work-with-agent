/** The replaced range between two versions of a text, as UTF-16 offsets in `after`. Never splits a surrogate pair. */
export function changedRange(before: string, after: string) {
  const limit = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < limit && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (suffix < limit - prefix && before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)) suffix++;
  let from = prefix; let to = after.length - suffix;
  const high = (index: number) => { const code = after.charCodeAt(index); return code >= 0xd800 && code <= 0xdbff; };
  if (from > 0 && from < after.length && high(from - 1)) from--;
  if (to > 0 && to < after.length && high(to - 1)) to++;
  return { from, to: Math.max(from, to) };
}

const mirrored = ['boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'tabSize', 'textIndent', 'wordSpacing', 'textTransform'] as const;

/** Vertical offset of a caret inside a textarea, measured with an off-screen copy of its text layout. */
function caretOffset(field: HTMLTextAreaElement, position: number) {
  const style = getComputedStyle(field);
  const mirror = document.createElement('div');
  for (const name of mirrored) mirror.style[name] = style[name];
  Object.assign(mirror.style, { position: 'absolute', visibility: 'hidden', top: '0', left: '-100000px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' });
  mirror.textContent = field.value.slice(0, position);
  const marker = document.createElement('span'); marker.textContent = '\u200b'; mirror.append(marker);
  document.body.append(mirror);
  try { return { top: marker.offsetTop, height: marker.offsetHeight || parseFloat(style.lineHeight) || 20 }; } finally { mirror.remove(); }
}

/** Place the caret and scroll the textarea, or its scrolling document pane, so the caret line is visible. */
export function revealTextareaCaret(field: HTMLTextAreaElement, position: number) {
  field.setSelectionRange(position, position);
  const caret = caretOffset(field, position);
  if (field.scrollHeight > field.clientHeight + 1) {
    if (caret.top < field.scrollTop || caret.top + caret.height > field.scrollTop + field.clientHeight) field.scrollTop = Math.max(0, caret.top - field.clientHeight / 3);
    return;
  }
  const scroller = field.closest<HTMLElement>('.document-scroll');
  if (!scroller) return;
  const top = field.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop + caret.top;
  if (top < scroller.scrollTop || top + caret.height > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = Math.max(0, top - scroller.clientHeight / 3);
}
