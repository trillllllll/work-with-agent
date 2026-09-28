const extension = /\.[A-Za-z0-9]{1,8}$/;

function clean(name: string) {
  return name.trim().replace(/[\\/:*?"<>|]/g, '_');
}

export function downloadFileName(name: string, reportedPath?: string | null) {
  const fromPath = reportedPath?.split(/[/\\]/).pop()?.trim() ?? '';
  if (fromPath && extension.test(fromPath)) return clean(fromPath);
  const wrapped = name.trim().match(/\(([^()\\/]+?\.[A-Za-z0-9]{1,8})\)\s*$/);
  if (wrapped?.[1]) return clean(wrapped[1]);
  const trimmed = name.trim();
  if (extension.test(trimmed)) return clean(trimmed);
  return clean(trimmed) || '产物';
}

export function isMarkdownFile(name: string) {
  return /\.(?:md|markdown)$/i.test(name);
}
