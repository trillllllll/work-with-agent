import { Button } from '@/components/ui/button.js';
import { useTranslation } from 'react-i18next';
import { Tooltip } from '@/components/ui/tooltip.js';
import { shortMonthDay } from '@/lib/stats-range.js';

export function HeatCells({ days, label }: { days: { date: string; count: number }[]; label: string }) {
  const { t } = useTranslation('stats');
  const cells = days.slice(-14);
  const max = Math.max(1, ...cells.map((cell) => cell.count));
  return (
    <div className="flex shrink-0 items-center gap-[3px]" role="group" aria-label={label}>
      {cells.map((cell) => {
        const text = t('chart.point', { date: shortMonthDay(cell.date), value: cell.count });
        const mix = cell.count <= 0 ? 0 : Math.max(22, Math.round((cell.count / max) * 100));
        const background = cell.count <= 0 ? 'var(--muted)' : `color-mix(in oklab, var(--tag-violet-fg) ${mix}%, var(--muted))`;
        return (
          <Tooltip key={cell.date} content={text}>
            <Button variant="plain" size="bare" type="button" className="size-3.5 shrink-0 rounded-[3px]" style={{ background }} aria-label={text} />
          </Tooltip>
        );
      })}
    </div>
  );
}
