export const materialKindNames: Record<string, string> = {
  text: '文本',
  markdown: 'Markdown',
  link: '链接',
  thread: '会话',
  attachment: '附件',
};

/** Display name for an imported file. The stored original name stays on the version. */
export function titleFromFileName(fileName: string) {
  const name = fileName.trim().slice(0, 255);
  const dot = name.lastIndexOf('.');
  const stem = (dot > 0 ? name.slice(0, dot) : name).trim();
  return (stem || name).slice(0, 300);
}

export function materialTypeLabel(kind: string, fileName?: string | null) {
  if (kind === 'attachment') {
    const name = fileName?.trim() ?? '';
    const dot = name.lastIndexOf('.');
    if (dot > 0 && dot < name.length - 1) return name.slice(dot + 1).toLocaleUpperCase('en-US');
    return materialKindNames.attachment;
  }
  return materialKindNames[kind] ?? kind;
}

export type AttachmentPreviewKind = 'markdown' | 'text' | 'html' | 'pdf' | 'docx' | 'image' | 'unsupported';

const textExtensions = new Set(['txt', 'csv', 'json', 'log']);
const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

/** How an imported file can be shown. Classification uses the current file name, not the material kind. */
export function attachmentPreviewKind(fileName?: string | null): AttachmentPreviewKind {
  const name = fileName?.trim() ?? '';
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (extension === 'md') return 'markdown';
  if (textExtensions.has(extension)) return 'text';
  if (extension === 'html' || extension === 'htm') return 'html';
  if (extension === 'pdf') return 'pdf';
  if (extension === 'docx') return 'docx';
  if (imageExtensions.has(extension)) return 'image';
  return 'unsupported';
}

/** Monday 00:00 in the local timezone, as a UTC timestamp. */
export function startOfLocalWeek(now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = start.getDay();
  start.setDate(start.getDate() - (day === 0 ? 6 : day - 1));
  return start.toISOString();
}
