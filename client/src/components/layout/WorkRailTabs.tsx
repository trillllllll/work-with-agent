import { FileText, Sparkles, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.js';

type RailTab = 'task' | 'assistant';
export function WorkRailTabs({ active, hasDraft, onSelect, onClose }: { active: RailTab; hasDraft: boolean; onSelect: (tab: RailTab) => void; onClose: () => void }) {
  const { t } = useTranslation('app');
  const tabs = [{ key: 'task', icon: FileText }, { key: 'assistant', icon: Sparkles }] as const;
  return <header className="dovun-rail-header">
    <div className="flex items-center justify-between pb-3"><span className="text-xs text-muted-foreground">{t('workRail.title')}</span><Button variant="ghost" size="icon-sm" aria-label={t('workRail.close')} onClick={onClose}><X /></Button></div>
    <div className="dovun-rail-tabs" role="tablist" aria-label={t('workRail.title')}>
      {tabs.map(({ key, icon: Icon }, index) => <Button key={key} id={`work-rail-tab-${key}`} variant="tab" size="bare" role="tab" aria-label={t(`workRail.${key}`)} aria-selected={active === key} aria-controls={`work-rail-panel-${key}`} tabIndex={active === key ? 0 : -1} onClick={() => onSelect(key)} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 'task' : event.key === 'End' ? 'assistant' : tabs[1 - index].key;
        onSelect(next); document.getElementById(`work-rail-tab-${next}`)?.focus();
      }}><Icon className="size-4" />{t(`workRail.${key}`)}{key === 'assistant' && hasDraft && active !== key && <span className="size-1.5 rounded-full bg-primary" aria-label={t('workRail.hasDraft')} />}</Button>)}
    </div>
  </header>;
}
