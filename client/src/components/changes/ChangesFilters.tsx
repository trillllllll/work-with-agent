import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronDown, Search, X } from 'lucide-react';
import { api, type ChangePage } from '@/lib/api.js';
import { cn } from '@/lib/utils.js';
import { useMediaQuery } from '@/hooks/useMediaQuery.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog.js';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.js';
import {
  CHANGE_ENTITY_TYPES, CHANGE_OP_GROUPS, CHANGE_RANGES, CHANGE_STATUSES, EMPTY_CHANGE_FILTERS,
  changeChips, filterCount, filtersToQueryPatch, removeChangeChip, toChangeApiQuery,
  type ChangeChip, type ChangeConnectionOption, type ChangeDateRange, type ChangeFilters,
} from './change-filters.js';

const SEARCH_DEBOUNCE_MS = 300;

type ChangesFiltersProps = {
  filters: ChangeFilters;
  connections: ChangeConnectionOption[];
  loaded: number | null;
  total: number | null;
  onSearch: (query: string) => void;
  onList: (key: 'type' | 'op' | 'source' | 'status', values: string[]) => void;
  onRange: (range: ChangeDateRange) => void;
  onReplace: (filters: ChangeFilters) => void;
};

function toggleValue(values: readonly string[], value: string) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function chipText(chip: ChangeChip, t: (key: string, options?: Record<string, unknown>) => string) {
  return t('changes.chip', { name: t(chip.nameKey), value: chip.valueKey ? t(chip.valueKey) : chip.valueText ?? '' });
}

export function ChangesFilters({ filters, connections, loaded, total, onSearch, onList, onRange, onReplace }: ChangesFiltersProps) {
  const { t } = useTranslation('settings');
  const desktop = useMediaQuery('(min-width: 1024px)');
  const [draftQuery, setDraftQuery] = useState(filters.q);
  const [composing, setComposing] = useState(false);
  const appliedQuery = filters.q;
  const [seenQuery, setSeenQuery] = useState(appliedQuery);
  if (seenQuery !== appliedQuery) {
    setSeenQuery(appliedQuery);
    setDraftQuery(appliedQuery);
  }
  useEffect(() => {
    if (composing) return;
    const clipped = filtersToQueryPatch({ ...EMPTY_CHANGE_FILTERS, q: draftQuery }).q ?? '';
    if (clipped === appliedQuery) return;
    const timer = window.setTimeout(() => onSearch(draftQuery), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draftQuery, composing, appliedQuery, onSearch]);

  const chips = changeChips(filters, connections);
  const countLabel = total == null ? null : t('changes.loadedCount', { loaded: loaded ?? 0, total });
  return <div className="mt-4">
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-0 flex-1 lg:max-w-xs">
        <Search className="pointer-events-none absolute top-1/2 left-3 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input type="search" value={draftQuery} placeholder={t('changes.searchPlaceholder')} aria-label={t('changes.searchPlaceholder')} className="h-9 rounded-full pr-3 pl-9" onChange={(event) => setDraftQuery(event.target.value)} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} />
      </div>
      {desktop
        ? <DesktopFilters filters={filters} connections={connections} onList={onList} onRange={onRange} />
        : <MobileFilters filters={filters} connections={connections} onReplace={onReplace} />}
    </div>
    {(chips.length > 0 || countLabel) && <div className="mt-2 flex flex-col gap-1.5 lg:flex-row lg:items-center lg:gap-2">
      <div className={cn('flex min-w-0 items-center gap-1.5', desktop ? 'flex-1 flex-wrap' : 'overflow-x-auto [scrollbar-width:none]')}>
        {chips.map((chip) => {
          const label = chipText(chip, t);
          return <span key={chip.id} className="inline-flex h-[26px] shrink-0 items-center gap-1 rounded-full bg-muted pr-1 pl-2.5 text-xs whitespace-nowrap">
            <span>{label}</span>
            <button type="button" className="grid size-4 place-items-center rounded-full text-muted-foreground hover:text-foreground" aria-label={t('changes.removeChip', { label })} onClick={() => onReplace(removeChangeChip(filters, chip.id))}><X className="size-3" /></button>
          </span>;
        })}
        {chips.length > 0 && <button type="button" className="shrink-0 px-1 text-xs underline underline-offset-2" onClick={() => onReplace(EMPTY_CHANGE_FILTERS)}>{t('changes.clearFilters')}</button>}
      </div>
      {countLabel && <span className="shrink-0 self-end text-xs whitespace-nowrap text-muted-foreground lg:self-auto">{countLabel}</span>}
    </div>}
  </div>;
}

function selectionText(labels: string[], fallback: string, t: (key: string, options?: Record<string, unknown>) => string) {
  if (labels.length === 0) return fallback;
  if (labels.length === 1) return labels[0];
  return t('changes.selectedCount', { count: labels.length });
}

function MultiMenu({ label, ariaLabel, selected, options, onToggle }: { label: string; ariaLabel: string; selected: readonly string[]; options: { value: string; label: string }[]; onToggle: (value: string) => void }) {
  const { t } = useTranslation('settings');
  const chosen = options.filter((option) => selected.includes(option.value)).map((option) => option.label);
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button type="button" variant="outline" aria-label={ariaLabel} className={cn('h-9 rounded-full px-3', selected.length > 0 && 'border-foreground/30 bg-muted')}>
        <span className="max-w-32 truncate">{selectionText(chosen, label, t)}</span>
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="z-[80] max-h-80 w-56">
      {options.map((option) => <DropdownMenuCheckboxItem key={option.value} checked={selected.includes(option.value)} onSelect={(event) => event.preventDefault()} onCheckedChange={() => onToggle(option.value)}>{option.label}</DropdownMenuCheckboxItem>)}
    </DropdownMenuContent>
  </DropdownMenu>;
}

function knownLabel(values: readonly string[], value: string, t: (key: string) => string, key: string) {
  return (values as readonly string[]).includes(value) ? t(`${key}.${value}`) : value;
}

function DesktopFilters({ filters, connections, onList, onRange }: { filters: ChangeFilters; connections: ChangeConnectionOption[]; onList: ChangesFiltersProps['onList']; onRange: ChangesFiltersProps['onRange'] }) {
  const { t } = useTranslation('settings');
  const types = uniqueOptions(CHANGE_ENTITY_TYPES, filters.type);
  const sources = sourceOptions(filters, connections, t);
  return <>
    <MultiMenu label={t('changes.filters.object')} ariaLabel={t('changes.filterType')} selected={filters.type} options={types.map((value) => ({ value, label: knownLabel(CHANGE_ENTITY_TYPES, value, t, 'changes.entities') }))} onToggle={(value) => onList('type', toggleValue(filters.type, value))} />
    <MultiMenu label={t('changes.filters.op')} ariaLabel={t('changes.filters.op')} selected={filters.op} options={CHANGE_OP_GROUPS.map((value) => ({ value, label: t(`changes.opGroups.${value}`) }))} onToggle={(value) => onList('op', toggleValue(filters.op, value))} />
    <MultiMenu label={t('changes.filters.source')} ariaLabel={t('changes.filters.source')} selected={filters.source} options={sources} onToggle={(value) => onList('source', toggleValue(filters.source, value))} />
    <MultiMenu label={t('changes.filters.status')} ariaLabel={t('changes.filters.status')} selected={filters.status} options={CHANGE_STATUSES.map((value) => ({ value, label: t(`changes.statuses.${value}`) }))} onToggle={(value) => onList('status', toggleValue(filters.status, value))} />
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" aria-label={t('changes.filters.range')} className={cn('h-9 rounded-full px-3', filters.range !== 'all' && 'border-foreground/30 bg-muted')}>
          <span className="max-w-32 truncate">{filters.range === 'all' ? t('changes.filters.range') : t(`changes.ranges.${filters.range}`)}</span>
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="z-[80] w-48">
        <DropdownMenuRadioGroup value={filters.range} onValueChange={(value) => onRange(value as ChangeDateRange)}>
          {CHANGE_RANGES.map((value) => <DropdownMenuRadioItem key={value} value={value}>{t(`changes.ranges.${value}`)}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  </>;
}

function uniqueOptions(known: readonly string[], selected: readonly string[]) {
  const extra = selected.filter((value) => !(known as readonly string[]).includes(value));
  return [...known, ...extra];
}

function sourceOptions(filters: ChangeFilters, connections: ChangeConnectionOption[], t: (key: string) => string) {
  const options = [
    { value: 'user', label: t('changes.sources.user') },
    { value: 'assistant', label: t('changes.sources.assistant') },
  ];
  const seen = new Set<string>();
  for (const connection of connections) {
    seen.add(connection.id);
    options.push({ value: `c:${connection.id}`, label: connection.name || t('changes.sources.deletedConnection') });
  }
  for (const value of filters.source) {
    if (!value.startsWith('c:')) continue;
    const id = value.slice(2);
    if (seen.has(id)) continue;
    seen.add(id);
    options.push({ value, label: t('changes.sources.deletedConnection') });
  }
  return options;
}

function MobileFilters({ filters, connections, onReplace }: { filters: ChangeFilters; connections: ChangeConnectionOption[]; onReplace: (filters: ChangeFilters) => void }) {
  const { t } = useTranslation('settings');
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(filters);
  const [debouncedDraft, setDebouncedDraft] = useState(filters);
  const count = filterCount(filters);
  const previewFilters = useMemo(() => ({ ...debouncedDraft, q: filters.q }), [debouncedDraft, filters.q]);
  const preview = useQuery({
    queryKey: ['changes', 'count', previewFilters],
    enabled: open,
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => api<ChangePage>(`/api/changes?${toChangeApiQuery(previewFilters, { limit: 1 })}`, { signal }),
  });
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => setDebouncedDraft(draft), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draft, open]);
  const openPanel = () => {
    setDraft(filters);
    setDebouncedDraft(filters);
    setOpen(true);
  };
  const apply = () => {
    onReplace({ ...draft, q: filters.q });
    setOpen(false);
  };
  const types = uniqueOptions(CHANGE_ENTITY_TYPES, draft.type);
  const sources = sourceOptions(draft, connections, t);
  return <>
    <Button type="button" variant="outline" className="h-9 rounded-full px-3" onClick={openPanel}>
      {count > 0 ? `${t('changes.filterButton')} (${count})` : t('changes.filterButton')}
    </Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent surface="glass" showCloseButton aria-describedby={undefined} overlayClassName="!z-[80]" className="!top-auto !bottom-0 !left-0 !z-[80] !flex max-h-[86dvh] w-full !max-w-none !translate-x-0 !translate-y-0 flex-col gap-0 !rounded-t-2xl !rounded-b-none p-0">
        <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-muted" />
        <DialogTitle className="px-4 py-3 text-left text-base">{t('changes.filterButton')}</DialogTitle>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          <OptionGroup title={t('changes.filters.object')}>
            {types.map((value) => <OptionButton key={value} pressed={draft.type.includes(value)} label={knownLabel(CHANGE_ENTITY_TYPES, value, t, 'changes.entities')} onClick={() => setDraft((current) => ({ ...current, type: toggleValue(current.type, value) }))} />)}
          </OptionGroup>
          <OptionGroup title={t('changes.filters.op')}>
            {CHANGE_OP_GROUPS.map((value) => <OptionButton key={value} pressed={draft.op.includes(value)} label={t(`changes.opGroups.${value}`)} onClick={() => setDraft((current) => ({ ...current, op: toggleValue(current.op, value) as ChangeFilters['op'] }))} />)}
          </OptionGroup>
          <OptionGroup title={t('changes.filters.source')}>
            {sources.map((option) => <OptionButton key={option.value} pressed={draft.source.includes(option.value)} label={option.label} onClick={() => setDraft((current) => ({ ...current, source: toggleValue(current.source, option.value) }))} />)}
          </OptionGroup>
          <OptionGroup title={t('changes.filters.status')}>
            {CHANGE_STATUSES.map((value) => <OptionButton key={value} pressed={draft.status.includes(value)} label={t(`changes.statuses.${value}`)} onClick={() => setDraft((current) => ({ ...current, status: toggleValue(current.status, value) as ChangeFilters['status'] }))} />)}
          </OptionGroup>
          <OptionGroup title={t('changes.filters.range')}>
            {CHANGE_RANGES.map((value) => <OptionButton key={value} pressed={draft.range === value} label={t(`changes.ranges.${value}`)} onClick={() => setDraft((current) => ({ ...current, range: value }))} />)}
          </OptionGroup>
          {preview.isError && <p role="alert" className="mt-3 text-sm text-destructive">{preview.error instanceof Error ? preview.error.message : t('changes.loadFailedFirst')}<Button type="button" variant="ghost" size="sm" className="ml-2" onClick={() => void preview.refetch()}>{t('changes.retry')}</Button></p>}
        </div>
        <div className="border-t glass-divider p-4">
          <Button type="button" className="w-full" disabled={preview.data == null} onClick={apply}>{preview.data ? t('changes.viewResults', { count: preview.data.total }) : t('changes.loading')}</Button>
        </div>
      </DialogContent>
    </Dialog>
  </>;
}

function OptionGroup({ title, children }: { title: string; children: ReactNode }) {
  return <section className="mt-3"><h3 className="text-xs font-medium text-muted-foreground">{title}</h3><div className="mt-2 flex flex-wrap gap-1.5">{children}</div></section>;
}

function OptionButton({ pressed, label, onClick }: { pressed: boolean; label: string; onClick: () => void }) {
  return <button type="button" aria-pressed={pressed} className={cn('inline-flex h-8 items-center rounded-full border px-3 text-sm', pressed ? 'border-primary bg-primary text-primary-foreground' : 'glass-control')} onClick={onClick}>{label}</button>;
}
