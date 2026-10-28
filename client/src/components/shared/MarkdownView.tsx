import { useCitations } from '@/components/chat/citation-context.js';
import { Button } from '@/components/ui/button.js';
import { Children, isValidElement, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/lib/utils.js';
import { isMermaidFence, mermaidSource } from '@/lib/mermaid-fence.js';
import { MermaidBlock } from './MermaidBlock.js';
import { isSvgFence } from '@/lib/svg-fence.js';
import { SvgBlock } from './SvgBlock.js';

function fenceText(children: ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(fenceText).join('');
  return '';
}

function hasMermaidFence(children: ReactNode) {
  return Children.toArray(children).some((child) => isValidElement<{ className?: string }>(child) && isMermaidFence(child.props.className));
}

function PreBlock({ children }: { children?: React.ReactNode }) {
  const { t } = useTranslation('chat');
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
      <Button variant="plain" size="bare" type="button" onClick={copy} aria-label={t('clipboard.copyCode')} className="absolute top-2 right-2 grid size-7 place-items-center rounded-md bg-white/10 text-zinc-300 opacity-0 transition-opacity group-hover/pre:opacity-100 hover:bg-white/20">
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
      <pre className="max-w-full overflow-x-auto rounded-lg bg-[#0d1117] p-3 text-xs leading-relaxed text-zinc-100">{children}</pre>
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

function markdownComponents(diagrams: boolean): Components {
  return {
    p: ({ children }) => <p className="my-1.5">{children}</p>,
    ul: ({ children }) => <ul className="my-1.5 list-disc pl-5">{children}</ul>,
    ol: ({ children }) => <ol className="my-1.5 list-decimal pl-5">{children}</ol>,
    li: ({ children }) => <li className="my-0.5">{children}</li>,
    h1: ({ children }) => <h1 className="mt-3 mb-1.5 text-base font-semibold">{children}</h1>,
    h2: ({ children }) => <h2 className="mt-3 mb-1.5 text-[15px] font-semibold">{children}</h2>,
    h3: ({ children }) => <h3 className="mt-2.5 mb-1 text-sm font-semibold">{children}</h3>,
    a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer" className="text-brand-link underline underline-offset-2">{children}</a>,
    blockquote: ({ children }) => <blockquote className="my-2 rounded-xl border border-border px-3 py-2 text-muted-foreground">{children}</blockquote>,
    code: ({ children, className }) => {
      if (diagrams && isMermaidFence(className)) return <MermaidBlock source={mermaidSource(fenceText(children))} />;
      const isBlock = /language-/.test(className ?? '');
      if (isBlock) return <code className="font-mono">{children}</code>;
      return <code className="rounded-md bg-muted px-1 py-0.5 font-mono text-[0.85em]">{children}</code>;
    },
    pre: ({ children }) => {
      const child = Children.toArray(children)[0];
      if (diagrams && isValidElement<{ className?: string; children?: ReactNode }>(child)) {
        const source = fenceText(child.props.children);
        if (isSvgFence(child.props.className, source)) return <SvgBlock source={source.replace(/\n$/, '')} />;
      }
      return diagrams && hasMermaidFence(children) ? <>{children}</> : <PreBlock>{children}</PreBlock>;
    },
    table: ({ children }) => (
      <div className="my-2 min-w-0 max-w-full overflow-x-auto">
        <table className="w-full border-collapse text-xs">{children}</table>
      </div>
    ),
    th: ({ children }) => <th className="border-b px-2 py-1.5 text-left font-semibold [overflow-wrap:anywhere]">{children}</th>,
    td: ({ children }) => <td className="border-b px-2 py-1.5 align-top [overflow-wrap:anywhere]">{children}</td>,
    hr: () => <hr className="my-3 border-border" />,
    strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  };
}

export function MarkdownView({ content, components, allowMaterialLinks = false, diagrams = false, className }: { content: string; components?: Components; allowMaterialLinks?: boolean; diagrams?: boolean; className?: string }) {
  const citations = useCitations();
  const citationComponents: Components = citations ? { a: ({ children, href }) => {
    const match = /^#source-(\d+)$/.exec(href ?? '');
    if (match) {
      const source = citations.sources[Number(match[1]) - 1];
      return source ? <Button variant="chip" size="bare" className="assistant-inline-citation" aria-label={tCitation(Number(match[1]), source.title)} onClick={() => citations.onSelect(source)}>{match[1]}</Button> : <span>{children}</span>;
    }
    return <a href={href} target="_blank" rel="noreferrer" className="text-brand-link underline underline-offset-2">{children}</a>;
  } } : {};
  const { t } = useTranslation('chat');
  const tCitation = (number: number, title: string) => t('sourceLinks.citation', { number, title });
  const urlTransform = allowMaterialLinks
    ? (url: string) => url.startsWith('wwa-material:') ? url : defaultUrlTransform(url)
    : undefined;
  const rendered = useMemo(() => markdownComponents(diagrams), [diagrams]);
  return (
    <div className={cn('markdown-body min-w-0 max-w-full break-words', className ?? 'text-[13.5px] leading-relaxed')}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ ...rendered, ...components, ...citationComponents }} urlTransform={urlTransform}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
