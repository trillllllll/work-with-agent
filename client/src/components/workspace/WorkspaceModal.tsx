import type { ReactNode } from 'react';
import { History, Settings, Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';
import { cn } from '@/lib/utils.js';

export type WorkspaceModalView = 'settings' | 'trash' | 'changes';

type WorkspaceModalProps = {
  view: WorkspaceModalView;
  onViewChange: (view: WorkspaceModalView) => void;
  onClose: () => void;
  settings: ReactNode;
  trash: ReactNode;
  changes: ReactNode;
};

const tabs: { view: WorkspaceModalView; label: string; description: string; icon: typeof Settings }[] = [
  { view: 'settings', label: '设置', description: '模型与接口配置', icon: Settings },
  { view: 'trash', label: '回收站', description: '恢复或永久删除任务', icon: Trash2 },
  { view: 'changes', label: '变更历史', description: '查看并撤销变更', icon: History },
];

export function WorkspaceModal({ view, onViewChange, onClose, settings, trash, changes }: WorkspaceModalProps) {
  const content = view === 'settings' ? settings : view === 'trash' ? trash : changes;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        showCloseButton
        overlayClassName="bg-black/30 backdrop-blur-md"
        className="flex h-[75dvh] w-full max-w-[900px] flex-col gap-0 overflow-hidden p-0 max-md:inset-0 max-md:h-dvh max-md:max-h-none max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-none"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>工作区</DialogTitle>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <aside className="shrink-0 border-b bg-card/90 p-3 md:w-56 md:border-r md:border-b-0 md:p-4">
            <div className="mb-3 px-2 md:mb-5">
              <span className="text-[11px] font-bold tracking-[0.13em] text-muted-foreground uppercase">工作区</span>
              <p className="mt-1 text-sm font-semibold">管理与审计</p>
            </div>
            <nav className="flex gap-1 overflow-x-auto md:flex-col" aria-label="工作区设置导航">
              {tabs.map(({ view: tabView, label, description, icon: Icon }) => {
                const active = tabView === view;
                return (
                  <button
                    key={tabView}
                    type="button"
                    aria-label={label}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => onViewChange(tabView)}
                    className={cn(
                      'flex min-w-max items-center gap-2 rounded-md px-3 py-2 text-left text-xs transition-colors md:min-w-0 md:py-2.5',
                      active ? 'bg-accent font-semibold text-accent-foreground' : 'text-muted-foreground hover:bg-accent/70 hover:text-accent-foreground',
                    )}
                  >
                    <Icon className="size-4 shrink-0" />
                    <span className="min-w-0">
                      <span className="block">{label}</span>
                      <span className="hidden text-[10px] font-normal opacity-75 md:block">{description}</span>
                    </span>
                  </button>
                );
              })}
            </nav>
          </aside>
          <section className="min-h-0 min-w-0 flex-1 overflow-hidden bg-background/95">
            <div className="h-full min-h-0 overflow-y-auto">{content}</div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
