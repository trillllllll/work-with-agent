import { useTranslation } from 'react-i18next';
import type { ProposalKind } from '@/lib/proposal-fields.js';
import { Button } from '@/components/ui/button.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.js';

export type FilterChoice = { id: string; label: string; count: number };
export type FilterValue = { type: 'all' | ProposalKind; source: string };

function choiceLabel(item: FilterChoice) {
  return `${item.label} ${item.count}`;
}

export function ProposalFilters({ types, sources, value, onChange }: { types: FilterChoice[]; sources: FilterChoice[]; value: FilterValue; onChange: (value: FilterValue) => void }) {
  const { t } = useTranslation('proposals');
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('filter.type')}>
        {types.map((item) => (
          <Button key={item.id} type="button" size="sm" variant={value.type === item.id ? 'default' : 'outline'} aria-pressed={value.type === item.id} onClick={() => onChange({ ...value, type: item.id as FilterValue['type'] })}>
            {choiceLabel(item)}
          </Button>
        ))}
      </div>
      <div className="hidden flex-wrap gap-2 sm:flex" role="group" aria-label={t('filter.source')}>
        {sources.map((item) => (
          <Button key={item.id} type="button" size="sm" variant={value.source === item.id ? 'default' : 'outline'} aria-pressed={value.source === item.id} onClick={() => onChange({ ...value, source: item.id })}>
            {choiceLabel(item)}
          </Button>
        ))}
      </div>
      <div className="sm:hidden">
        <Select value={value.source} onValueChange={(source) => onChange({ ...value, source })}>
          <SelectTrigger aria-label={t('filter.sources')} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {sources.map((item) => <SelectItem key={item.id} value={item.id}>{choiceLabel(item)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
