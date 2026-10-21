/** A non-archived topic the access picker can show and search. */
export type AccessTopic = { id: string; name: string };

export type AccessSelection = {
  includeInbox: boolean;
  /** Checked ids. May include archived topics and missing ids that are not in `topics`. */
  topicIds: string[];
};

function normalizedQuery(query: string) {
  return query.trim().toLowerCase();
}

/** Case-insensitive name search. Pass only non-archived topics; inbox and archived lists are not inputs. */
export function filterTopics<T extends AccessTopic>(topics: readonly T[], query: string): T[] {
  const needle = normalizedQuery(query);
  if (!needle) return [...topics];
  return topics.filter((topic) => topic.name.toLowerCase().includes(needle));
}

function matchingIds(topics: readonly AccessTopic[], query: string) {
  return new Set(filterTopics(topics, query).map((topic) => topic.id));
}

/**
 * No query: check the inbox and every non-archived topic. Archived and missing ids already checked stay checked.
 * With a query: check only the topics whose names match. Inbox, archived ids, missing ids, and other topics stay as they are.
 */
export function selectAll(current: AccessSelection, topics: readonly AccessTopic[], query: string): AccessSelection {
  if (!normalizedQuery(query)) {
    const listed = new Set(topics.map((topic) => topic.id));
    const extras = current.topicIds.filter((id) => !listed.has(id));
    return { includeInbox: true, topicIds: [...topics.map((topic) => topic.id), ...extras] };
  }
  const matched = matchingIds(topics, query);
  const have = new Set(current.topicIds);
  const added = [...matched].filter((id) => !have.has(id));
  return { includeInbox: current.includeInbox, topicIds: [...current.topicIds, ...added] };
}

/**
 * No query: clear the inbox, every non-archived topic, and any still-checked missing or archived id.
 * With a query: uncheck only the non-archived topics whose names match.
 */
export function clearSelection(current: AccessSelection, topics: readonly AccessTopic[], query: string): AccessSelection {
  if (!normalizedQuery(query)) return { includeInbox: false, topicIds: [] };
  const matched = matchingIds(topics, query);
  return { includeInbox: current.includeInbox, topicIds: current.topicIds.filter((id) => !matched.has(id)) };
}

/** Edit mode: checked topics first. Relative order inside each group stays the same. */
export function orderSelectedFirst<T extends AccessTopic>(topics: readonly T[], selectedIds: readonly string[]): T[] {
  const selected = new Set(selectedIds);
  return topics
    .map((topic, index) => ({ topic, index, rank: selected.has(topic.id) ? 0 : 1 }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.topic);
}

/** “已选” filter for the scroll area. Only selected non-archived topics remain, in their current order. */
export function filterSelected<T extends AccessTopic>(topics: readonly T[], selectedIds: readonly string[]): T[] {
  const selected = new Set(selectedIds);
  return topics.filter((topic) => selected.has(topic.id));
}

/** Selected and total both include the inbox row. Archived and missing ids are not part of this count. */
export function accessCount(topics: readonly AccessTopic[], includeInbox: boolean, selectedIds: readonly string[]) {
  const selected = new Set(selectedIds);
  const selectedTopics = topics.reduce((count, topic) => count + (selected.has(topic.id) ? 1 : 0), 0);
  return { selected: selectedTopics + (includeInbox ? 1 : 0), total: topics.length + 1 };
}

/** Ids to persist: drop missing lists, keep archived ids that are still checked. */
export function topicIdsForSave(selectedIds: readonly string[], missingIds: readonly string[]) {
  const missing = new Set(missingIds);
  return selectedIds.filter((id) => !missing.has(id));
}
