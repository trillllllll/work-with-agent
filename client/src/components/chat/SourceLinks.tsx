import { Button } from '@/components/ui/button.js';
import { useTranslation } from 'react-i18next';
import type { AssistantSource } from '../../../../server/src/domain/assistant-source.js';
export function SourceLinks({ sources }: { sources: AssistantSource[] }) {
  const { t } = useTranslation('chat');
  if (!sources.length) return null;
  return <div className="mt-2 flex flex-wrap gap-1.5" aria-label={t('sourceLinks.label')}>{sources.map((source) => <Button variant="chip" size="bare" key={`${source.kind}:${source.id}:${source.revision ?? ''}`} type="button" className="max-w-full truncate rounded-lg px-2 py-1 text-left text-xs text-brand-link" onClick={() => window.dispatchEvent(new CustomEvent('dovun-open-source', { detail: source }))}>{source.title}{source.revision ? ` · v${source.revision}` : ''}</Button>)}</div>;
}
