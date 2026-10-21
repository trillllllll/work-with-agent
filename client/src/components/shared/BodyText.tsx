import type { Components } from 'react-markdown';
import { cn } from '@/lib/utils.js';
import { MarkdownView } from './MarkdownView.js';

export type TextFormat = 'markdown' | 'plain';

const sizeClass = { xs: 'text-xs', sm: 'text-sm' } as const;

export function textFormatForMaterial(kind: string, mimeType?: string | null): TextFormat {
  if (kind === 'markdown' || kind === 'thread') return 'markdown';
  if (mimeType === 'text/markdown') return 'markdown';
  return 'plain';
}

export function BodyText({ text, format = 'plain', size = 'sm', mono = false, className, components }: {
  text: string;
  format?: TextFormat;
  size?: keyof typeof sizeClass;
  mono?: boolean;
  className?: string;
  components?: Components;
}) {
  if (format === 'markdown' && text.trim()) {
    return <MarkdownView content={text} components={components} className={cn(sizeClass[size], className)} />;
  }
  if (mono) return <pre className={cn('whitespace-pre-wrap break-all font-mono', sizeClass[size], className)}>{text}</pre>;
  return <p className={cn('whitespace-pre-wrap break-words', sizeClass[size], className)}>{text}</p>;
}
