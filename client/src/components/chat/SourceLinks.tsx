import { useTranslation } from 'react-i18next';
import type { AssistantSource } from '../../../../server/src/agent/assistant-sources.js';
export function SourceLinks({ sources }: { sources: AssistantSource[] }) {
  const { t } = useTranslation('chat');
  if (!sources.length) return null;
  return <div className="mt-2 flex flex-wrap gap-1.5" aria-label={t('sourceLinks.label')}>{sources.map((source) => <button key={`${source.kind}:${source.id}:${source.revision ?? ''}`} type="button" className="max-w-full truncate rounded-lg border px-2 py-1 text-left text-xs text-brand-link hover:bg-muted" onClick={() => window.dispatchEvent(new CustomEvent('dovun-open-source', { detail: source }))}>{source.title}{source.revision ? ` · v${source.revision}` : ''}</button>)}</div>;
}
