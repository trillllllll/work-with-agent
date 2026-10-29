import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { documentChanges } from './document-difference.js';

export function DocumentChanges({ base, local, remote }: { base: unknown; local: unknown; remote: unknown }) {
  const { t } = useTranslation('library');
  const sides = useMemo(() => [{ key: 'mine', changes: documentChanges(base, local) }, { key: 'remote', changes: documentChanges(base, remote) }], [base, local, remote]);
  return <div className="document-change-summary">{sides.map(({ key, changes }) => <section key={key}><h3>{t(`document.${key}`)} · {t('document.changeCount', { count: changes.length })}</h3><ol>{changes.slice(0, 100).map((change) => <li key={change.id}><strong>{t(`document.change.${change.kind}`)}</strong>{change.before != null && <pre>{change.before}</pre>}{change.after != null && <pre>{change.after}</pre>}</li>)}</ol>{changes.length > 100 && <p>{t('document.changeExcerpt')}</p>}</section>)}</div>;
}
