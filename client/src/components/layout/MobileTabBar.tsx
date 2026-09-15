import { FolderKanban, MessageSquare, SquareKanban, Trash2, History } from 'lucide-react';
import type { View } from '@/lib/api.js';
import { cn } from '@/lib/utils.js';

type MobileTabBarProps = {
  route: View;
  navigate: (view: View) => void;
};

const tabs: { view: View; label: string; icon: typeof SquareKanban }[] = [
  { view: 'board', label: '看板', icon: SquareKanban },
  { view: 'chat', label: '聊天', icon: MessageSquare },
  { view: 'topics', label: '主题', icon: FolderKanban },
  { view: 'trash', label: '回收站', icon: Trash2 },
  { view: 'changes', label: '历史', icon: History },
];

export function MobileTabBar({ route, navigate }: MobileTabBarProps) {
  return (
    <nav className="glass-surface grid shrink-0 grid-cols-5 border-x-0 border-b-0 rounded-none pb-[env(safe-area-inset-bottom)]" aria-label="主导航">
      {tabs.map(({ view, label, icon: Icon }) => {
        const active = route === view;
        return (
          <button
            key={view}
            type="button"
            aria-current={active ? 'page' : undefined}
            onClick={() => navigate(view)}
            className={cn('flex flex-col items-center gap-1 py-2.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60', active ? 'text-primary' : 'text-muted-foreground')}
          >
            <Icon className="size-5" strokeWidth={active ? 2.4 : 1.8} />
            {label}
          </button>
        );
      })}
    </nav>
  );
}
