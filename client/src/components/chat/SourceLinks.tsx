import type { AssistantSource } from '../../../../server/src/agent/assistant-sources.js';
export function SourceLinks({ sources }: { sources: AssistantSource[] }) {
  if (!sources.length) return null;
  return <div className="mt-2 flex flex-wrap gap-1.5" aria-label="本次查阅的来源">{sources.map((source) => <button key={`${source.kind}:${source.id}:${source.revision ?? ''}`} type="button" className="max-w-full truncate rounded-lg border px-2 py-1 text-left text-xs text-primary hover:bg-muted" onClick={() => window.dispatchEvent(new CustomEvent('wwa-open-source', { detail: source }))}>{source.title}{source.revision ? ` · v${source.revision}` : ''}</button>)}</div>;
}
