import { CitationContext } from './citation-context.js';
import { Button } from '@/components/ui/button.js';
import { Disclosure, DisclosureTrigger } from '@/components/ui/disclosure.js';
import { Modal } from '@/components/ui/modal.js';
import { MarkdownView } from '@/components/shared/MarkdownView.js';
import { BookOpen, ChevronDown, ChevronRight, LoaderCircle, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api.js';
import { intlLocale } from '@/i18n/index.js';
import { uniqueAssistantSources, type AssistantSource } from '../../../../server/src/domain/assistant-source.js';

export function SourceLinks({ sources, onSelect }: { sources: AssistantSource[]; onSelect: (source: AssistantSource) => void }) {
  const { t } = useTranslation('chat');
  const unique = uniqueAssistantSources(sources);
  if (!unique.length) return null;
  return <Disclosure className="assistant-sources" data-testid="assistant-sources"><DisclosureTrigger className="assistant-sources-trigger"><BookOpen className="size-3.5" /><span>{t('sourceLinks.count', { count: unique.length })}</span><ChevronDown className="ml-auto size-3" /></DisclosureTrigger>
    <div className="pb-1">{unique.map((source, index) => <Button variant="row" size="bare" key={`${source.kind}:${source.id}:${source.revision ?? ''}`} type="button" className="assistant-source-row" onClick={() => onSelect(source)}>
      <span className="assistant-source-number">{index + 1}</span><span className="min-w-0 flex-1"><span className="block truncate">{sourceTitle(source, t('sourceLinks.conversation'))}</span><small className="block text-muted-foreground">{t(`sourceLinks.kinds.${source.kind}`)}{source.revision ? ` · v${source.revision}` : ''}{source.createdAt && Number.isFinite(Date.parse(source.createdAt)) ? ` · ${new Date(source.createdAt).toLocaleString(intlLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''}</small></span><ChevronRight className="size-3" />
    </Button>)}</div></Disclosure>;
}
function sourceTitle(source: AssistantSource, fallback: string) {
  // i18n-ignore: legacy persisted title format, not a rendered label.
  return source.kind === 'conversation' && /^历史对话\s*·\s*\d{4}-/.test(source.title) ? fallback : source.title;
}
export function SourcePreview({ source, onClose }: { source: AssistantSource; onClose: () => void }) {
  const { t } = useTranslation('chat');
  const [result, setResult] = useState<{ title: string; content: string } | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true; setResult(null); setError('');
    void api<{ title: string; content: string }>(`/api/v1/assistant/sources/${source.kind}/${encodeURIComponent(source.id)}${source.revision ? `?revision=${source.revision}` : ''}`).then(value => { if (current) setResult(value); }, error => { if (current) setError(error instanceof Error ? error.message : t('sourceLinks.unavailable')); });
    return () => { current = false; };
  }, [source.kind, source.id, source.revision, attempt, t]);
  return <Modal title={t('sourceLinks.preview')} onClose={onClose} data-assistant-floating className="assistant-source-preview">
    <header className="mb-4 flex items-center gap-2"><BookOpen className="size-4 text-muted-foreground" /><h2 className="min-w-0 flex-1 text-sm font-semibold">{result?.title || sourceTitle(source, t('sourceLinks.conversation'))}</h2><Button variant="ghost" size="icon-sm" aria-label={t('sourceLinks.close')} onClick={onClose}><X /></Button></header>
    <p className="mb-3 text-[11px] text-muted-foreground">{t(`sourceLinks.kinds.${source.kind}`)}{source.revision ? ` · v${source.revision}` : ''}</p>
    {error ? <div role="alert"><p className="text-sm text-destructive">{error}</p><Button variant="outline" size="sm" className="mt-3" onClick={() => setAttempt(value => value + 1)}>{t('actions.retry')}</Button></div> : result ? <CitationContext.Provider value={null}><MarkdownView content={result.content || t('sourceLinks.empty')} /></CitationContext.Provider> : <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" />{t('sourceLinks.loading')}</p>}
  </Modal>;
}
