import { Component, lazy, memo, Suspense, type ReactNode } from 'react';
import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import type { ContentBlock } from '@/lib/message-blocks.js';
import { MarkdownView } from './MarkdownView.js';
const VisualizationBlock = lazy(() => import('./VisualizationBlock.js'));
class BlockBoundary extends Component<{ children: ReactNode; alt?: string }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() { return { error: true }; }
  render() { return this.state.error ? <p role="alert" className="rounded-xl border p-4 text-sm">这部分内容无法显示。{this.props.alt}</p> : this.props.children; }
}
const Block = memo(function Block({ block }: { block: ContentBlock }) {
  return <div data-block-id={block.id} data-block-type={block.type} data-block-status={block.status} className="min-w-0">
    {block.type === 'text' ? block.status === 'pending' ? <p className="streaming-caret whitespace-pre-wrap break-words text-[13.5px] leading-relaxed">{block.markdown}</p> : <MarkdownView content={block.markdown ?? ''} /> : block.status === 'ready' && ['mermaid', 'chart', 'svg', 'image_search'].includes(block.type) ? <BlockBoundary alt={block.alt}><Suspense fallback={<p className="p-4 text-xs text-muted-foreground">正在加载可视化…</p>}><VisualizationBlock block={block} /></Suspense></BlockBoundary> : block.status === 'pending' ? <p role="status" className="rounded-xl border p-4 text-xs text-muted-foreground">正在生成内容…</p> : block.status === 'ready' ? <p className="rounded-xl border p-4 text-xs text-muted-foreground">{block.alt || '当前版本暂不支持显示这类内容，可查看文字回复。'}</p> : null}
    {block.status === 'error' && <div role="alert" className="mt-2 rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-xs">{block.error || '这部分内容未完成'}{block.alt && <p className="mt-1 text-muted-foreground">{block.alt}</p>}{block.source && <details className="mt-2"><summary className="cursor-pointer">查看源码</summary><pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words py-2">{block.source}</pre><button type="button" className="inline-flex items-center gap-1" onClick={() => void navigator.clipboard.writeText(block.source!).then(() => toast.success('已复制源码'), () => toast.error('复制失败'))}><Copy size={12} />复制源码</button></details>}</div>}
  </div>;
});
export function MessageBlocks({ blocks }: { blocks: ContentBlock[] }) { return <div className="flex min-w-0 flex-col gap-4">{blocks.map((block) => <Block key={block.id} block={block} />)}</div>; }
