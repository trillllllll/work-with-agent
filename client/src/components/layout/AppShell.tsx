import type { ReactNode } from 'react';
import type { View } from '@/lib/api.js';
import { MobileTabBar } from './MobileTabBar.js';

type AppShellProps = {
  route: View;
  isDesktop: boolean;
  chatOpen: boolean;
  navigate: (view: View) => void;
  sidebar: ReactNode;
  board: ReactNode;
  inbox: ReactNode;
  chat: ReactNode;
  topics: ReactNode;
};

export function AppShell({ route, isDesktop, chatOpen, navigate, sidebar, board, inbox, chat, topics }: AppShellProps) {
  if (isDesktop) {
    const desktopGridClass = chatOpen ? 'grid-cols-[240px_minmax(0,1fr)_380px]' : 'grid-cols-[240px_minmax(0,1fr)]';
    return (
      <div className={`grid h-dvh ${desktopGridClass} overflow-hidden bg-background`}>
        {sidebar}
        <section className="min-h-0 min-w-0 overflow-y-auto bg-background/80 glass-scrollbar">{route === 'inbox' ? inbox : board}</section>
        {chatOpen && <aside className="min-h-0 border-l glass-divider bg-[var(--glass-subtle)]">{chat}</aside>}
      </div>
    );
  }
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background">
      <div className="glass-scrollbar min-h-0 flex-1 overflow-y-auto">
        {route === 'chat' ? chat : route === 'topics' ? topics : route === 'inbox' ? inbox : board}
      </div>
      <MobileTabBar route={route} navigate={navigate} />
    </div>
  );
}
