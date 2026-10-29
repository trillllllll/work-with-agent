import { useEffect, useState } from 'react';
import DOMPurify from 'dompurify';
import './highlighted-code.css';

export function languageForFile(name?: string | null) {
  const extension = name?.split('.').pop()?.toLowerCase() ?? '';
  return ({ js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', json: 'json', py: 'python', sql: 'sql', sh: 'bash', bash: 'bash', html: 'xml', xml: 'xml', svg: 'xml', css: 'css', go: 'go', rs: 'rust', java: 'java', c: 'cpp', h: 'cpp', cpp: 'cpp', yml: 'yaml', yaml: 'yaml' } as Record<string, string>)[extension] ?? '';
}

/** Read-only highlighting is delayed and bounded; it never changes the authoritative text. */
export function HighlightedCode({ code, language }: { code: string; language: string }) {
  const [highlight, setHighlight] = useState<{ code: string; language: string; html: string } | null>(null);
  useEffect(() => {
    if (code.length > 100_000 || !language) return;
    let active = true;
    const timer = setTimeout(() => {
      void import('./code-highlighter.js').then(({ highlightCode }) => highlightCode(code, language)).then((html) => {
        if (active && html !== null) setHighlight({ code, language, html: DOMPurify.sanitize(html, { ALLOWED_TAGS: ['span'], ALLOWED_ATTR: ['class'] }) });
      }).catch(() => {});
    }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [code, language]);
  const html = highlight?.code === code && highlight.language === language ? highlight.html : null;
  return html === null ? <code className="document-highlight font-mono" data-language={language}>{code}</code> : <code className="document-highlight font-mono" data-language={language} dangerouslySetInnerHTML={{ __html: html }} />;
}
