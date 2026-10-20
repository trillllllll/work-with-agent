import { useTranslation } from 'react-i18next';
import type { Topic } from '@/lib/api.js';
import { ScopePicker, type ScopePickerLabels } from '@/components/shared/ScopePicker.js';

type AccessPickerProps = {
  topics: Topic[];
  archivedTopics: Topic[];
  missingIds: string[];
  includeInbox: boolean;
  topicIds: string[];
  /** Edit mode keeps the initially selected lists at the top for this dialog session. */
  pinSelected: boolean;
  onChange: (next: { includeInbox: boolean; topicIds: string[] }) => void;
};

export function AccessPicker({ topics, archivedTopics, missingIds, includeInbox, topicIds, pinSelected, onChange }: AccessPickerProps) {
  const { t } = useTranslation('workspace');
  const labels: ScopePickerLabels = {
    legend: t('connections.scopeLegend'),
    count: (selected, total) => t('connections.accessCount', { selected, total }),
    missingCount: (count) => t('connections.accessMissingCount', { count }),
    selectAll: t('connections.selectAll'),
    clear: t('connections.clear'),
    searchAria: t('connections.searchAria'),
    searchPlaceholder: (count) => t('connections.searchLists', { count }),
    inboxAria: t('connections.inboxAccess'),
    inboxHint: t('connections.inboxHint'),
    itemAria: (name) => t('connections.listAccess', { name }),
    missingName: () => t('connections.unnamedMissing'),
    missingRow: (name) => t('connections.missingRow', { name }),
    archivedBadge: t('connections.archivedBadge'),
    filterAll: t('connections.filterAll'),
    filterSelected: (count) => t('connections.filterSelected', { count }),
    footer: `${t('connections.scopeRequired')} ${t('connections.archivedNote')}`,
  };
  return (
    <ScopePicker
      topics={topics}
      archivedTopics={archivedTopics}
      missingIds={missingIds}
      includeInbox={includeInbox}
      topicIds={topicIds}
      pinSelected={pinSelected}
      onChange={onChange}
      labels={labels}
      exploringLabel={t('settings:topicList.exploring')}
    />
  );
}
