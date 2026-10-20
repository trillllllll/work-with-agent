import { useTranslation } from 'react-i18next';
import { evidenceSummariesOf, formatFieldValue, legacyEvidence, type EvidenceSummary } from '@/lib/proposal-fields.js';
import { displayText } from './present.js';

function typeName(type: string, t: (key: string) => string): string {
  if (type === 'task' || type === 'material' || type === 'memory') return t(`evidence.type.${type}`);
  return type;
}

function SummaryCard({ item }: { item: EvidenceSummary }) {
  const { t } = useTranslation('proposals');
  const status = item.status ? formatFieldValue('status', item.status) : null;
  const statusText = status && status.kind !== 'omit' ? displayText(status) : '';
  return (
    <li className="rounded-lg border border-[var(--glass-border)] px-3 py-2 text-sm">
      <div className="font-medium">{item.title || typeName(item.type, t)}</div>
      {item.unavailable ? <div className="text-xs text-muted-foreground">{t('evidence.unavailable')}</div> : (
        <div className="mt-1 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
          {item.title ? <span>{typeName(item.type, t)}</span> : null}
          {item.topicName ? <span>{item.topicName}</span> : null}
          <span>{t('evidence.version', { revision: item.revision })}</span>
          {statusText ? <span>{statusText}</span> : null}
        </div>
      )}
    </li>
  );
}

export function EvidenceList({ detail, fallbackEvidence, mark }: { detail: Record<string, unknown>; fallbackEvidence?: unknown; mark?: string }) {
  const { t } = useTranslation('proposals');
  const summaries = evidenceSummariesOf(detail);
  const legacy = summaries === null ? legacyEvidence(detail.evidence ?? fallbackEvidence) : [];
  const count = summaries?.length || legacy.length;
  if (!count) return null;
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">{mark ? `${mark} ` : ''}{t('evidence.count', { count })}</h3>
      <ul className="space-y-2">
        {summaries?.map((item) => <SummaryCard key={`${item.type}:${item.id}:${item.revision}`} item={item} />)}
        {legacy.map((item) => (
          <li key={`${item.type}:${item.id}:${item.revision}`} className="rounded-lg border border-[var(--glass-border)] px-3 py-2 text-sm">
            <div>{t('evidence.legacy', { type: typeName(item.type, t), revision: item.revision })}</div>
            <div className="mt-1 text-xs text-muted-foreground">{t('evidence.legacyHint')}</div>
          </li>
        ))}
      </ul>
    </section>
  );
}
