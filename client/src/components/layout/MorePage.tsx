import { ChevronRight, MessageSquare } from 'lucide-react';
import type { View } from '@/lib/api.js';
import { navigation } from '@/components/layout/Sidebar.js';
import { ThemeToggle } from '@/components/layout/ThemeToggle.js';
import { cn } from '@/lib/utils.js';

const groups: { label: string; views: View[] }[] = [
  { label: '视图', views: ['inbox', 'today', 'plan', 'focus', 'quadrant', 'topics'] },
  { label: '整理', views: ['search', 'tags', 'archived'] },
  { label: '工作', views: ['connections', 'proposals', 'library', 'runs', 'reviews'] },
  { label: '系统', views: ['settings', 'trash', 'changes'] },
];

type MorePageProps = {
  route: View;
  onNavigate: (view: View) => void;
};

export function MorePage({ route, onNavigate }: MorePageProps) {
  return (
    <div className="mx-auto w-full max-w-2xl p-4 pb-10 sm:p-6 lg:max-w-4xl">
      <header className="mb-5 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">工作区</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">浏览全部视图与工具</p>
        </div>
        <ThemeToggle />
      </header>
      <button
        type="button"
        onClick={() => onNavigate('chat')}
        className="glass-subtle mb-6 flex min-h-14 w-full items-center gap-3 rounded-2xl px-4 text-left transition-colors hover:bg-[var(--glass-hover)]"
      >
        <span className="glass-control flex size-9 shrink-0 items-center justify-center rounded-xl">
          <MessageSquare aria-hidden="true" className="size-5" strokeWidth={1.75} />
        </span>
        <span className="flex-1 text-[15px] font-medium">打开聊天</span>
        <ChevronRight aria-hidden="true" className="size-4 text-muted-foreground" />
      </button>
      <nav aria-label="工作区导航" className="grid gap-6 lg:grid-cols-2">
        {groups.map((group) => (
          <section key={group.label} aria-label={group.label}>
            <h2 className="mb-1.5 px-3 text-xs font-medium text-muted-foreground">{group.label}</h2>
            <div className="glass-subtle overflow-hidden rounded-2xl">
              {group.views.map((view, index) => {
                const item = navigation.find((entry) => entry.view === view)!;
                const Icon = item.icon;
                const active = route === view;
                return (
                  <button
                    key={view}
                    type="button"
                    onClick={() => onNavigate(view)}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex min-h-12 w-full items-center gap-3 px-4 text-left transition-colors hover:bg-[var(--glass-hover)]',
                      index > 0 && 'border-t border-[var(--glass-divider)]',
                      active && 'bg-[color-mix(in_srgb,var(--foreground)_8%,transparent)] font-semibold',
                    )}
                  >
                    <Icon aria-hidden="true" className="size-5 shrink-0" strokeWidth={1.75} />
                    <span className="flex-1 text-[15px]">{item.label}</span>
                    <ChevronRight aria-hidden="true" className="size-4 text-muted-foreground" />
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </nav>
    </div>
  );
}
