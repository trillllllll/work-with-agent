import type { Topic } from './api.js';

/** Monday through Sunday. Stored weekDay still uses 0 for Sunday. */
export const weekdayOrder = [1, 2, 3, 4, 5, 6, 0];

export function sortRules<T extends { id: string; enabled: boolean }>(rules: T[], latestByRule: ReadonlyMap<string, { status: string } | undefined>) {
  const rank = (rule: T) => {
    if (!rule.enabled) return 2;
    return latestByRule.get(rule.id)?.status === 'failed' ? 0 : 1;
  };
  return rules
    .map((rule, index) => ({ rule, index, rank: rank(rule) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((item) => item.rule);
}

export function latestBatchByRule<T extends { ruleId: string; createdAt: string }>(batches: T[]) {
  const latest = new Map<string, T>();
  for (const batch of batches) {
    const current = latest.get(batch.ruleId);
    if (!current || batch.createdAt > current.createdAt) latest.set(batch.ruleId, batch);
  }
  return latest;
}

export function needsAttention(batch: { status: string }) {
  return batch.status === 'partial' || batch.status === 'failed' || batch.status === 'generating';
}

export function classifyScope(topicIds: string[], topics: Topic[], archivedTopics: Topic[], archivedLoaded: boolean) {
  const activeById = new Map(topics.map((topic) => [topic.id, topic]));
  const archivedById = new Map(archivedTopics.map((topic) => [topic.id, topic]));
  const active: Topic[] = [];
  const archived: Topic[] = [];
  const missingIds: string[] = [];
  for (const id of topicIds) {
    const current = activeById.get(id);
    if (current) { active.push(current); continue; }
    const archivedTopic = archivedById.get(id);
    if (archivedTopic) { archived.push(archivedTopic); continue; }
    if (archivedLoaded) missingIds.push(id);
  }
  return { active, archived, missingIds };
}

export function formatInZone(iso: string, locale: string, timeZone?: string) {
  const options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };
  if (timeZone) options.timeZone = timeZone;
  return new Intl.DateTimeFormat(locale, options).format(new Date(iso));
}

export function localizeIsoTimes(markdown: string, locale: string, timeZone?: string) {
  return markdown.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, (iso) => formatInZone(iso, locale, timeZone));
}
