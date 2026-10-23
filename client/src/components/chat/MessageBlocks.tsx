import { Component, lazy, memo, Suspense, type ReactNode } from 'react';
import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import type { ContentBlock } from '@/lib/message-blocks.js';
import { MarkdownView } from '@/components/shared/MarkdownView.js';
const VisualizationBlock = lazy(() => import('./VisualizationBlock.js'));
const HtmlBlock = lazy(() => import('./HtmlBlock.js'));
function BlockFallback({ alt }: { alt?: string }) {
  const { t } = useTranslation('chat');
  return <p role="alert" className="rounded-xl border p-4 text-sm">{alt ? t('messageBlocks.unavailableWithAlt', { alt }) : t('messageBlocks.unavailable')}</p>;
}
class BlockBoundary extends Component<{ children: ReactNode; alt?: string }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() { return { error: true }; }
  render() { return this.state.error ? <BlockFallback alt={this.props.alt} /> : this.props.children; }
}
const Block = memo(function Block({ block }: { block: ContentBlock }) {
  const { t } = useTranslation('chat');
  return <div data-block-id={block.id} data-block-type={block.type} data-block-status={block.status} className="min-w-0">
    {block.type === 'text' ? block.status === 'pending' ? <p className="streaming-caret whitespace-pre-wrap break-words text-[13.5px] leading-relaxed">{block.markdown}</p> : <MarkdownView content={block.markdown ?? ''} diagrams /> : block.status === 'ready' && block.type === 'html' ? <BlockBoundary alt={block.alt}><Suspense fallback={<p className="p-4 text-xs text-muted-foreground">{t('messageBlocks.loadingHtml')}</p>}><HtmlBlock block={block} /></Suspense></BlockBoundary> : block.status === 'ready' && ['mermaid', 'chart', 'svg', 'image_search'].includes(block.type) ? <BlockBoundary alt={block.alt}><Suspense fallback={<p className="p-4 text-xs text-muted-foreground">{t('messageBlocks.loadingVisualization')}</p>}><VisualizationBlock block={block} /></Suspense></BlockBoundary> : block.status === 'pending' ? <p role="status" className="rounded-xl border p-4 text-xs text-muted-foreground">{t('messageBlocks.generating')}</p> : block.status === 'ready' ? <p className="rounded-xl border p-4 text-xs text-muted-foreground">{block.alt || t('messageBlocks.unsupported')}</p> : null}
    {block.status === 'error' && <div role="alert" className="mt-2 rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-xs">{block.error || t('messageBlocks.partIncomplete')}{block.alt && <p className="mt-1 text-muted-foreground">{block.alt}</p>}{block.source && <details className="mt-2"><summary className="cursor-pointer">{t('clipboard.viewSource')}</summary><pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words py-2">{block.source}</pre><button type="button" className="inline-flex items-center gap-1" onClick={() => void navigator.clipboard.writeText(block.source!).then(() => toast.success(t('clipboard.sourceCopied')), () => toast.error(t('clipboard.copyFailed')))}><Copy size={12} />{t('clipboard.copySource')}</button></details>}</div>}
  </div>;
});
export function MessageBlocks({ blocks }: { blocks: ContentBlock[] }) { return <div className="flex min-w-0 flex-col gap-4">{blocks.map((block) => <Block key={block.id} block={block} />)}</div>; }
