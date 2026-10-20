import { useLayoutEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { History, Settings, Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';
import { cn } from '@/lib/utils.js';

export type WorkspaceModalView = 'settings' | 'trash' | 'changes';

type WorkspaceModalProps = {
  suspended?: boolean;
  assistantOpen?: boolean;
  assistantSlot?: (node: HTMLDivElement | null) => void;
  onOpenAssistant?: () => void;
  view: WorkspaceModalView;
  onViewChange: (view: WorkspaceModalView) => void;
  onClose: () => void;
  settings: ReactNode;
  trash: ReactNode;
  changes: ReactNode;
};

export function WorkspaceModal({ suspended = false, assistantOpen, assistantSlot, onOpenAssistant, view, onViewChange, onClose, settings, trash, changes }: WorkspaceModalProps) {
  const { t } = useTranslation('workspace');
  const tabs: { view: WorkspaceModalView; label: string; description: string; icon: typeof Settings }[] = [
    { view: 'settings', label: t('modal.settings'), description: t('modal.settingsTab'), icon: Settings },
    { view: 'trash', label: t('modal.trash'), description: t('modal.trashTab'), icon: Trash2 },
    { view: 'changes', label: t('modal.changes'), description: t('modal.changesTab'), icon: History },
  ];
  const titles: Record<WorkspaceModalView, { eyebrow: string; title: string; description: string }> = {
    settings: { eyebrow: t('modal.settingsEyebrow'), title: t('modal.settings'), description: t('modal.settingsDescription') },
    trash: { eyebrow: t('modal.trashEyebrow'), title: t('modal.trash'), description: t('modal.trashDescription') },
    changes: { eyebrow: t('modal.changesEyebrow'), title: t('modal.changes'), description: t('modal.changesDescription') },
  };
  const content = view === 'settings' ? settings : view === 'trash' ? trash : changes;
  const current = titles[view];

  const [businessHost] = useState(() => { const node = document.createElement('div'); node.className = 'flex min-h-0 flex-1 flex-col'; return node; });
  const [businessSlot, setBusinessSlot] = useState<HTMLDivElement | null>(null);
  const [parkingSlot, setParkingSlot] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const slot = suspended ? parkingSlot : businessSlot;
    if (slot) slot.appendChild(businessHost);
  }, [suspended, parkingSlot, businessSlot, businessHost]);
  return (<>
    <div hidden ref={setParkingSlot} />
    <Dialog open={!suspended} onOpenChange={(open) => { if (!open) onClose(); }}>
    {createPortal(<>        <DialogHeader className="relative shrink-0 border-b border-black/[0.06] px-6 pb-4 pt-5 pr-16 text-left dark:border-white/[0.08] sm:px-8 sm:pt-6 sm:pr-20">
          <button type="button" className="mb-2 self-start text-sm text-primary" onClick={onOpenAssistant}>{t('modal.assistant')}</button>
          <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/80">{current.eyebrow}</span>
          <DialogTitle className="mt-1.5 text-[26px] font-semibold tracking-[-0.025em]">{current.title}</DialogTitle>
          <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-muted-foreground">{current.description}</p>
        </DialogHeader>

        <nav className="relative shrink-0 overflow-x-auto border-b border-black/[0.06] px-5 py-3 [scrollbar-width:none] dark:border-white/[0.08] sm:px-8" aria-label={t('modal.nav')}>
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
          <div className="glass-scrollbar h-full min-h-0 overflow-y-auto overscroll-contain">{content}</div>
        </section>
</>, businessHost)}
      <DialogContent
        onInteractOutside={(event) => {
          if (event.target instanceof Element && event.target.closest('[data-assistant-floating]')) event.preventDefault();
        }}
        showCloseButton={!assistantOpen}
        overlayClassName="bg-slate-950/20 backdrop-blur-md backdrop-saturate-150 dark:bg-black/35"
        closeButtonClassName="top-5 right-5 z-10 size-9 rounded-full border border-white/30 bg-white/35 p-2 text-foreground/70 opacity-100 shadow-sm backdrop-blur-xl transition-colors hover:bg-white/60 hover:text-foreground dark:border-white/10 dark:bg-white/10 dark:hover:bg-white/20 [&_svg]:size-4"
        className={cn(
          'glass-overlay flex h-[80dvh] w-[min(78vw,1120px)] max-w-[min(1120px,calc(100%-2rem))] flex-col gap-0 rounded-xl p-0 text-foreground duration-300',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[0.98] motion-reduce:!animate-none',
          'max-md:h-[calc(100dvh-1rem)]',
          assistantOpen && 'assistant-workspace-open lg:!w-[calc(100vw-2rem)] lg:!max-w-[1440px]',
        )}
      >
        <div className={cn("flex min-h-0 flex-1", assistantOpen && "max-lg:flex-col")}><div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", assistantOpen && "max-lg:hidden")}>
        <div ref={setBusinessSlot} className="flex min-h-0 flex-1 flex-col" />
        </div><div ref={assistantSlot} className={cn("w-[400px] shrink-0 border-l max-lg:h-full max-lg:w-full", !assistantOpen && "hidden")} /></div>
      </DialogContent>
    </Dialog>
  </>);
}
