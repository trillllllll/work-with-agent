import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api.js';
import { Button } from '@/components/ui/button.js';
import type { SkillListItem } from '@/components/skills/skill-format.js';

/** Same key and path as the unfiltered list on the skills page, so both share one cache entry. */
export const skillsQueryOptions = { queryKey: ['skills', '', 'all', ''], queryFn: () => api<SkillListItem[]>('/api/skills') };

export function skillCounts(skills: SkillListItem[] | undefined) {
  const live = (skills ?? []).filter((skill) => !skill.deletedAt);
  return { count: live.length, enabled: live.filter((skill) => skill.enabled).length };
}

export function SkillsSummary({ onOpenSkills }: { onOpenSkills: () => void }) {
  const { t } = useTranslation('settings');
  const skills = useQuery(skillsQueryOptions);
  const counts = skillCounts(skills.data);
  return (
    <section aria-labelledby="settings-skills-title">
      <h3 id="settings-skills-title" className="text-lg font-semibold">{t('skillsCard.title')}</h3>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{t('skillsCard.description')}</p>
      <p className="glass-subtle mt-4 rounded-xl px-4 py-3 text-sm" data-testid="settings-skills-stats">
        {skills.isError ? t('layout.skillsSummary.loadFailed') : skills.data ? t('layout.skillsSummary.stats', counts) : t('layout.hints.loading')}
      </p>
      <Button variant="outline" className="mt-4" onClick={onOpenSkills}>{t('skillsCard.manage')}</Button>
    </section>
  );
}
