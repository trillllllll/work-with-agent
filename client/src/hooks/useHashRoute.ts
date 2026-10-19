import { useCallback, useEffect, useState } from 'react';
import type { View } from '../lib/api.js';

const validViews: View[] = ['board', 'quadrant', 'chat', 'topics', 'inbox', 'settings', 'trash', 'changes', 'today', 'search', 'tags', 'archived', 'more', 'connections', 'proposals', 'knowledge', 'library', 'runs', 'worktrees', 'reviews', 'plan', 'focus'];
const knowledgeSections = ['materials', 'memories', 'brief', 'search', 'tree', 'graph', 'extractions'] as const;
export type KnowledgeSection = (typeof knowledgeSections)[number];

type HashState = {
  view: View;
  knowledgeSection: KnowledgeSection | null;
  /** Empty string is the inbox. Null means the query did not name a scope. */
  knowledgeTopicId: string | null;
  knowledgeTopicExplicit: boolean;
};

function hashPath() {
  return window.location.hash.replace(/^#\/?/, '').split('?')[0] ?? '';
}

function hashQuery() {
  const raw = window.location.hash;
  const index = raw.indexOf('?');
  return new URLSearchParams(index >= 0 ? raw.slice(index + 1) : '');
}

function readTopic(params: URLSearchParams) {
  if (!params.has('topicId')) return { id: null, explicit: false };
  const value = params.get('topicId') ?? '';
  if (value === 'inbox') return { id: '', explicit: true };
  return { id: value, explicit: true };
}

export function knowledgeHash(section: KnowledgeSection, topicId: string) {
  const topic = topicId ? topicId : 'inbox';
  return `/knowledge/${section}?topicId=${encodeURIComponent(topic)}`;
}

function parseHash(path: string, params: URLSearchParams): HashState {
  const topic = readTopic(params);
  const [head, ...rest] = path.split('/');
  const section = rest.join('/');
  if (head === 'knowledge') {
    const knowledgeSection = (knowledgeSections as readonly string[]).includes(section) ? section as KnowledgeSection : 'brief';
    return { view: 'knowledge', knowledgeSection, knowledgeTopicId: topic.id, knowledgeTopicExplicit: topic.explicit };
  }
  if ((validViews as string[]).includes(head)) return { view: head as View, knowledgeSection: null, knowledgeTopicId: null, knowledgeTopicExplicit: false };
  return { view: 'inbox', knowledgeSection: null, knowledgeTopicId: null, knowledgeTopicExplicit: false };
}

function applyHash(next: string, mode: 'push' | 'replace') {
  const hash = next.startsWith('/') ? next : `/${next}`;
  if (window.location.hash.replace(/^#/, '') === hash) return;
  if (mode === 'replace') {
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${hash}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    return;
  }
  window.location.hash = hash;
}

export function useHashRoute() {
  const [state, setState] = useState<HashState>(() => parseHash(hashPath(), hashQuery()));
  useEffect(() => {
    const sync = () => setState(parseHash(hashPath(), hashQuery()));
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  const navigate = useCallback((view: View) => {
    applyHash(view === 'knowledge' ? '/knowledge/brief' : `/${view}`, 'push');
  }, []);
  const openKnowledge = useCallback((section: KnowledgeSection, topicId: string, mode: 'push' | 'replace' = 'push') => {
    applyHash(knowledgeHash(section, topicId), mode);
  }, []);
  return {
    route: state.view,
    knowledgeSection: state.knowledgeSection,
    knowledgeTopicId: state.knowledgeTopicId,
    knowledgeTopicExplicit: state.knowledgeTopicExplicit,
    navigate,
    openKnowledge,
  };
}
