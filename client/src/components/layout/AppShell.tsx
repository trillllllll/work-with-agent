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
  settings: ReactNode;
  trash: ReactNode;
  changes: ReactNode;
};

export function AppShell({ route, isDesktop, navigate, sidebar, board, chat, topics, settings, trash, changes }: AppShellProps) {
  if (isDesktop) {
    return (
      <div className="grid h-dvh grid-cols-[240px_minmax(0,1fr)_380px] overflow-hidden">
        {sidebar}
        <section className="min-h-0 min-w-0 overflow-y-auto bg-background">{route === 'settings' ? settings : route === 'trash' ? trash : route === 'changes' ? changes : board}</section>
        <aside className="min-h-0 border-l bg-card">{chat}</aside>
      </div>
    );
  }
  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-hidden">
        {route === 'chat' ? chat : route === 'topics' ? topics : route === 'settings' ? settings : route === 'trash' ? trash : route === 'changes' ? changes : board}
      </div>
      <MobileTabBar route={route} navigate={navigate} />
    </div>
  );
}
