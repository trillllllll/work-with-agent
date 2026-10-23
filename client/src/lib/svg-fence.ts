/** Recognize SVG fences and complete SVG documents in unlabelled/XML/HTML fences. */
export function isSvgFence(className: string | null | undefined, source: string) {
  const language = /(?:^|\s)language-([^\s]+)/i.exec(className ?? '')?.[1]?.toLowerCase();
  return language === 'svg' || ((!language || language === 'xml' || language === 'html') && /^\s*<svg\b[\s\S]*<\/svg>\s*$/i.test(source));
}
