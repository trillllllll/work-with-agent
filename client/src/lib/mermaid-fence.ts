export function isMermaidFence(className?: string | null) {
  return /(?:^|\s)language-mermaid(?:\s|$)/.test(className ?? '');
}

export function mermaidSource(text: string) {
  return text.replace(/\n$/, '');
}
