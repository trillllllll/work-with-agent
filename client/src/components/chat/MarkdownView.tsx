import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';

function PreBlock({ children }: { children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const raw = extractText(children);
    try {
      await navigator.clipboard.writeText(raw);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  };
  return (
    <div className="group/pre relative my-2">
      <button type="button" onClick={copy} aria-label="复制代码" className="absolute top-2 right-2 grid size-7 place-items-center rounded-md bg-white/10 text-zinc-300 opacity-0 transition-opacity group-hover/pre:opacity-100 hover:bg-white/20">
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
      <pre className="overflow-x-auto rounded-lg bg-[#0d1117] p-3 text-xs leading-relaxed text-zinc-100">{children}</pre>
    </div>
  );
}

function extractText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (typeof node === 'object' && 'props' in (node as React.ReactElement)) {
    return extractText((node as React.ReactElement<{ children?: React.ReactNode }>).props.children);
  }
  return '';
}

export function MarkdownView({ content }: { content: string }) {
  return (
    <div className="markdown-body text-[13.5px] leading-relaxed break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="my-1.5">{children}</p>,
          ul: ({ children }) => <ul className="my-1.5 list-disc pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-1.5 list-decimal pl-5">{children}</ol>,
          li: ({ children }) => <li className="my-0.5">{children}</li>,
          h1: ({ children }) => <h1 className="mt-3 mb-1.5 text-base font-semibold">{children}</h1>,
          h2: ({ children }) => <h2 className="mt-3 mb-1.5 text-[15px] font-semibold">{children}</h2>,
          h3: ({ children }) => <h3 className="mt-2.5 mb-1 text-sm font-semibold">{children}</h3>,
          a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">{children}</a>,
          blockquote: ({ children }) => <blockquote className="my-2 border-l-2 border-border pl-3 text-muted-foreground">{children}</blockquote>,
          code: ({ children, className }) => {
            const isBlock = /language-/.test(className ?? '');
            if (isBlock) return <code className="font-mono">{children}</code>;
            return <code className="rounded-md bg-muted px-1 py-0.5 font-mono text-[0.85em]">{children}</code>;
          },
          pre: ({ children }) => <PreBlock>{children}</PreBlock>,
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto">
              <table className="w-full border-collapse text-xs">{children}</table>
            </div>
          ),
          th: ({ children }) => <th className="border-b px-2 py-1.5 text-left font-semibold">{children}</th>,
          td: ({ children }) => <td className="border-b px-2 py-1.5 align-top">{children}</td>,
          hr: () => <hr className="my-3 border-border" />,
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
