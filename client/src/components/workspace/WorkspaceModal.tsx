import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, History, Settings, Sparkles, Trash2, X } from 'lucide-react';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@/components/ui/dialog.js';
import { Button } from '@/components/ui/button.js';
import { cn } from '@/lib/utils.js';

export type WorkspaceModalView = 'settings' | 'trash' | 'changes';

type WorkspaceModalProps = {
  suspended?: boolean;
  assistantOpen?: boolean;
  assistantSlot?: (node: HTMLDivElement | null) => void;
  onOpenAssistant?: () => void;
  view: WorkspaceModalView;
  /** Below 1024px the modal is full screen: a settings list, detail pages, and a floating assistant button. */
  mobile?: boolean;
  /** Title of the open settings category on phones; null shows the category list. */
  detailTitle?: string | null;
  /** Phones: the "‹" button on a detail page goes back to the settings list. */
  onBack?: () => void;
  onViewChange: (view: WorkspaceModalView) => void;
  onClose: () => void;
  settings: ReactNode;
  trash: ReactNode;
  changes: ReactNode;
};

export function WorkspaceModal({ suspended = false, assistantOpen, assistantSlot, onOpenAssistant, view, mobile = false, detailTitle = null, onBack, onViewChange, onClose, settings, trash, changes }: WorkspaceModalProps) {
  const { t } = useTranslation('workspace');
  const tabs: { view: WorkspaceModalView; label: string; icon: typeof Settings }[] = [
    { view: 'settings', label: t('modal.settings'), icon: Settings },
    { view: 'trash', label: t('modal.trash'), icon: Trash2 },
    { view: 'changes', label: t('modal.changes'), icon: History },
  ];
  const content = view === 'settings' ? settings : view === 'trash' ? trash : changes;
  const currentLabel = tabs.find((tab) => tab.view === view)!.label;
  // Phones: trash and changes are detail pages of the settings list as well.
  const mobileDetail = mobile ? (view === 'settings' ? detailTitle : currentLabel) : null;

  const [businessHost] = useState(() => { const node = document.createElement('div'); node.className = 'flex min-h-0 flex-1 flex-col'; return node; });
  const [businessSlot, setBusinessSlot] = useState<HTMLDivElement | null>(null);
  const [parkingSlot, setParkingSlot] = useState<HTMLDivElement | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const slot = suspended ? parkingSlot : businessSlot;
    if (slot) slot.appendChild(businessHost);
  }, [suspended, parkingSlot, businessSlot, businessHost]);
  // Every page starts at the top, and entering a detail page moves focus to its back button.
  useLayoutEffect(() => { if (scroller.current) scroller.current.scrollTop = 0; }, [view, mobileDetail]);
  const enteredDetail = useRef(false);
  useLayoutEffect(() => {
    if (!mobileDetail) { enteredDetail.current = true; return; }
    if (enteredDetail.current) backButton.current?.focus();
    enteredDetail.current = false;
  }, [mobileDetail]);

  const closeButton = !assistantOpen && (
    <DialogClose asChild>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={t('modal.close')} className="shrink-0 rounded-full text-foreground/70 hover:text-foreground"><X /></Button>
    </DialogClose>
  );

  const header = mobile ? (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-black/[0.06] px-3 dark:border-white/[0.08]">
      {mobileDetail ? (
        <>
          <Button ref={backButton} type="button" variant="ghost" className="-ml-1 h-10 min-w-0 gap-1 px-2 text-base font-semibold" aria-label={t('settings:layout.nav.back')} onClick={onBack}>
            <ChevronLeft className="size-5 shrink-0" />
            <span className="truncate">{mobileDetail}</span>
          </Button>
          <DialogTitle className="sr-only">{mobileDetail}</DialogTitle>
        </>
      ) : (
        <DialogTitle className="px-1 text-lg font-semibold">{t('modal.settings')}</DialogTitle>
      )}
      <span className="flex-1" />
      {closeButton}
    </header>
  ) : (
    <header className="flex shrink-0 items-center gap-3 border-b border-black/[0.06] px-5 py-3 dark:border-white/[0.08] sm:px-6">
      <DialogTitle className="sr-only">{currentLabel}</DialogTitle>
      <nav className="min-w-0 overflow-x-auto [scrollbar-width:none]" aria-label={t('modal.nav')}>
        <div className="flex min-w-max gap-1 rounded-full border border-black/[0.06] bg-black/[0.035] p-1 shadow-inner dark:border-white/[0.08] dark:bg-white/[0.06]">
          {tabs.map(({ view: tabView, label, icon: Icon }) => {
            const active = tabView === view;
            return (
              <button
                key={tabView}
                type="button"
                aria-label={label}
                aria-current={active ? 'page' : undefined}
                onClick={() => onViewChange(tabView)}
                className={cn(
                  'group flex min-h-9 items-center gap-2 rounded-full px-4 py-1.5 text-left transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 motion-reduce:transition-none',
                  active
                    ? 'bg-white/80 text-foreground shadow-[0_2px_8px_rgb(15_23_42/0.10),inset_0_1px_0_rgb(255_255_255/0.85)] dark:bg-white/15 dark:text-foreground dark:shadow-[0_2px_8px_rgb(0_0_0/0.2),inset_0_1px_0_rgb(255_255_255/0.12)]'
                    : 'text-muted-foreground hover:bg-white/45 hover:text-foreground dark:hover:bg-white/10',
                )}
              >
                <Icon className={cn('size-4 shrink-0 transition-colors', active ? 'text-primary' : 'text-muted-foreground/80 group-hover:text-foreground')} />
                <span className="whitespace-nowrap text-[13px] font-medium">{label}</span>
              </button>
            );
          })}
        </div>
      </nav>
      <span className="flex-1" />
      <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={onOpenAssistant}><Sparkles className="size-4" />{t('modal.assistant')}</Button>
      {closeButton}
    </header>
  );

  return (<>
    <div hidden ref={setParkingSlot} />
    <Dialog open={!suspended} onOpenChange={(open) => { if (!open) onClose(); }}>
    {createPortal(<>
        {header}
        <section className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-white/15 dark:bg-black/10">
          <div ref={scroller} data-testid="workspace-modal-scroller" className="glass-scrollbar h-full min-h-0 overflow-y-auto overscroll-contain">{content}</div>
          {mobile && !assistantOpen && (
            <Button
              type="button"
              data-testid="workspace-assistant-fab"
              className="absolute right-4 z-10 h-11 rounded-full px-4 shadow-lg"
              style={{ bottom: 'calc(16px + env(safe-area-inset-bottom))' }}
              onClick={onOpenAssistant}
            >
              <Sparkles className="size-4" />{t('modal.assistant')}
            </Button>
          )}
        </section>
</>, businessHost)}
      <DialogContent
        onInteractOutside={(event) => {
          if (event.target instanceof Element && event.target.closest('[data-assistant-floating]')) event.preventDefault();
        }}
        showCloseButton={false}
        aria-describedby={undefined}
        overlayClassName="bg-slate-950/20 backdrop-blur-md backdrop-saturate-150 dark:bg-black/35"
        className={cn(
          'glass-overlay flex flex-col gap-0 p-0 text-foreground duration-300',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[0.98] motion-reduce:!animate-none',
          mobile
            ? 'h-dvh w-full max-w-none rounded-none pt-[env(safe-area-inset-top)]'
            : 'h-[80dvh] w-[min(78vw,1120px)] max-w-[min(1120px,calc(100%-2rem))] rounded-xl',
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
