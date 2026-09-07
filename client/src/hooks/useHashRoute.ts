import { useCallback, useEffect, useState } from 'react';
import type { View } from '../lib/api.js';

const validViews: View[] = ['board', 'chat', 'topics', 'settings', 'trash', 'changes'];

function readHash(): View {
  const hash = window.location.hash.replace(/^#\/?/, '');
  return (validViews as string[]).includes(hash) ? (hash as View) : 'board';
}

export function useHashRoute() {
  const [route, setRoute] = useState<View>(readHash);
  useEffect(() => {
    const onHashChange = () => setRoute(readHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  const navigate = useCallback((view: View) => {
    window.location.hash = view === 'board' ? '/' : `/${view}`;
  }, []);
  return { route, navigate };
}
