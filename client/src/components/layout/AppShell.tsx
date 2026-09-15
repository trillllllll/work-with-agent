import type { ReactNode } from 'react';
import type { View } from '@/lib/api.js';
import { MobileTabBar } from './MobileTabBar.js';

type AppShellProps = {
  route: View;
  isDesktop: boolean;
  navigate: (view: View) => void;
  sidebar: ReactNode;
  board: ReactNode;
  chat: ReactNode;
  topics: ReactNode;
};

export function AppShell({ route, isDesktop, navigate, sidebar, board, chat, topics }: AppShellProps) {
  if (isDesktop) {
    return (
      <div className="grid h-dvh grid-cols-[240px_minmax(0,1fr)_380px] overflow-hidden bg-background">
        {sidebar}
        <section className="min-h-0 min-w-0 overflow-y-auto bg-background/80 glass-scrollbar">{board}</section>
        <aside className="min-h-0 border-l glass-divider bg-[var(--glass-subtle)]">{chat}</aside>
      </div>
    );
  }
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background">
      <div className="glass-scrollbar min-h-0 flex-1 overflow-y-auto">
        {route === 'chat' ? chat : route === 'topics' ? topics : board}
      </div>
      <MobileTabBar route={route} navigate={navigate} />
    </div>
  );
}
