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

const titles: Record<WorkspaceModalView, { eyebrow: string; title: string; description: string }> = {
  settings: { eyebrow: '工作区偏好', title: '设置', description: '管理模型连接与工作区偏好' },
  trash: { eyebrow: '工作区管理', title: '回收站', description: '恢复任务，或清理不再需要的内容' },
  changes: { eyebrow: '审计记录', title: '变更历史', description: '查看工作区变更，并撤销仍然安全可逆的操作' },
};

export function WorkspaceModal({ view, onViewChange, onClose, settings, trash, changes }: WorkspaceModalProps) {
  const content = view === 'settings' ? settings : view === 'trash' ? trash : changes;
  const current = titles[view];

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        showCloseButton
        overlayClassName="bg-slate-950/20 backdrop-blur-md backdrop-saturate-150 dark:bg-black/35"
        closeButtonClassName="top-5 right-5 z-10 size-9 rounded-full border border-white/30 bg-white/35 p-2 text-foreground/70 opacity-100 shadow-sm backdrop-blur-xl transition-colors hover:bg-white/60 hover:text-foreground dark:border-white/10 dark:bg-white/10 dark:hover:bg-white/20 [&_svg]:size-4"
        className={cn(
          'isolate flex h-[80dvh] w-[min(78vw,1120px)] max-w-none flex-col gap-0 overflow-hidden rounded-[24px] border border-white/55 bg-white/65 p-0 text-foreground shadow-[0_24px_80px_-28px_rgb(15_23_42/0.45),0_8px_28px_-16px_rgb(15_23_42/0.28)] backdrop-blur-2xl backdrop-saturate-150 duration-300 before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-28 before:bg-gradient-to-b before:from-white/55 before:to-transparent before:content-[""] dark:border-white/15 dark:bg-slate-900/58 dark:shadow-[0_24px_80px_-28px_rgb(0_0_0/0.7),0_8px_28px_-16px_rgb(0_0_0/0.45)] dark:before:from-white/10',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[0.98] motion-reduce:!animate-none',
          'max-md:h-[calc(100dvh-1rem)] max-md:w-[calc(100vw-1rem)] max-md:rounded-[20px]',
        )}
      >
        <DialogHeader className="relative shrink-0 border-b border-black/[0.06] px-6 pb-4 pt-5 pr-16 text-left dark:border-white/[0.08] sm:px-8 sm:pt-6 sm:pr-20">
          <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/80">{current.eyebrow}</span>
          <DialogTitle className="mt-1.5 text-[26px] font-semibold tracking-[-0.025em]">{current.title}</DialogTitle>
          <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-muted-foreground">{current.description}</p>
        </DialogHeader>

        <nav className="relative shrink-0 overflow-x-auto border-b border-black/[0.06] px-5 py-3 [scrollbar-width:none] dark:border-white/[0.08] sm:px-8" aria-label="工作区设置导航">
          <div className="flex min-w-max gap-1 rounded-full border border-black/[0.06] bg-black/[0.035] p-1 shadow-inner dark:border-white/[0.08] dark:bg-white/[0.06]">
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
                    'group flex min-h-10 items-center gap-2 rounded-full px-4 py-2 text-left transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 motion-reduce:transition-none',
                    active
                      ? 'bg-white/80 text-foreground shadow-[0_2px_8px_rgb(15_23_42/0.10),inset_0_1px_0_rgb(255_255_255/0.85)] dark:bg-white/15 dark:text-foreground dark:shadow-[0_2px_8px_rgb(0_0_0/0.2),inset_0_1px_0_rgb(255_255_255/0.12)]'
                      : 'text-muted-foreground hover:bg-white/45 hover:text-foreground dark:hover:bg-white/10',
                  )}
                >
                  <Icon className={cn('size-4 shrink-0 transition-colors', active ? 'text-primary' : 'text-muted-foreground/80 group-hover:text-foreground')} />
                  <span className="whitespace-nowrap text-[13px] font-medium">{label}</span>
                  <span className="hidden whitespace-nowrap text-[11px] text-muted-foreground/75 lg:inline">{description}</span>
                </button>
              );
            })}
          </div>
        </nav>

        <section className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-white/15 dark:bg-black/10">
          <div className="h-full min-h-0 overflow-y-auto overscroll-contain [scrollbar-color:rgb(100_116_139/0.35)_transparent] [scrollbar-width:thin]">{content}</div>
        </section>
      </DialogContent>
    </Dialog>
  );
}
