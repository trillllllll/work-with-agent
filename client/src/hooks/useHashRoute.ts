import { useCallback, useEffect, useState } from 'react';
import type { View } from '../lib/api.js';

const validViews: View[] = ['board', 'quadrant', 'chat', 'topics', 'inbox', 'settings', 'trash', 'changes', 'today', 'search', 'tags', 'archived', 'more', 'connections', 'proposals', 'knowledge', 'library', 'runs', 'reviews', 'plan', 'focus'];
const knowledgeSections = ['materials', 'memories', 'brief', 'search', 'tree', 'graph'] as const;
export type KnowledgeSection = (typeof knowledgeSections)[number];

type HashState = { view: View; knowledgeSection: KnowledgeSection | null };

function hashPath() {
  return window.location.hash.replace(/^#\/?/, '').split('?')[0] ?? '';
}

function parseHash(hash: string): HashState {
  if (hash === 'knowledge') return { view: 'library', knowledgeSection: null };
  const [head, ...rest] = hash.split('/');
  const section = rest.join('/');
  if (head === 'knowledge' && (knowledgeSections as readonly string[]).includes(section)) return { view: 'knowledge', knowledgeSection: section as KnowledgeSection };
  if ((validViews as string[]).includes(head)) return { view: head as View, knowledgeSection: null };
  return { view: 'inbox', knowledgeSection: null };
}

function redirectBareKnowledge() {
  if (hashPath() !== 'knowledge') return;
  window.location.replace(`${window.location.pathname}${window.location.search}#/library`);
}

export function useHashRoute() {
  const [state, setState] = useState<HashState>(() => parseHash(hashPath()));
  useEffect(() => {
    const sync = () => {
      if (hashPath() === 'knowledge') {
        redirectBareKnowledge();
        setState({ view: 'library', knowledgeSection: null });
        return;
      }
      setState(parseHash(hashPath()));
    };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  const navigate = useCallback((view: View) => {
    window.location.hash = `/${view}`;
  }, []);
  return { route: state.view, knowledgeSection: state.knowledgeSection, navigate };
}
