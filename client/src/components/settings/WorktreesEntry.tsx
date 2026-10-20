import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.js';

export function WorktreesEntry({ onOpenWorktrees }: { onOpenWorktrees: () => void }) {
  const { t } = useTranslation('settings');
  return (
    <section aria-labelledby="settings-worktrees-title">
      <h3 id="settings-worktrees-title" className="text-lg font-semibold">{t('layout.worktreesEntry.title')}</h3>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{t('layout.worktreesEntry.description')}</p>
      <Button variant="outline" className="mt-4" onClick={onOpenWorktrees}>{t('layout.worktreesEntry.manage')}</Button>
    </section>
  );
}
