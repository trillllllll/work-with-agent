import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CalendarDays, MessageSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, type Settings, type Task } from '@/lib/api.js';
import { intlLocale } from '@/i18n/index.js';
import mark from '@/assets/dovun-mark.svg';

type Props = { tasks: Task[]; today: string; compact?: boolean; onOpen: () => void; onAsk: (text: string) => void; onConfigure: () => void; onOpenTask: (id: string) => void };

/** A launcher into the one existing conversation, never another chat instance. */
export function WorkCompanion({ tasks, today, compact, onOpen, onAsk, onConfigure, onOpenTask }: Props) {
  const { t } = useTranslation('app');
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('/api/settings') });
  const configured = Boolean(settings.data?.model && settings.data?.baseUrl && settings.data?.apiKeyConfigured);
  const agenda = tasks.filter(task => task.status !== 'done' && task.scheduledStart?.slice(0, 10) === today).sort((a, b) => a.scheduledStart!.localeCompare(b.scheduledStart!)).slice(0, 4);
  return <div className={`dovun-companion${compact ? ' is-compact' : ''}`}>
    {!compact && <section className="dovun-agenda" aria-label={t('companion.agenda')}>
      <div className="dovun-section-label"><CalendarDays size={15} /><h2>{t('companion.agenda')}</h2></div>
      {agenda.length ? agenda.map(task => <button key={task.id} type="button" onClick={() => onOpenTask(task.id)}><time>{new Intl.DateTimeFormat(intlLocale(), { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(task.scheduledStart!))}</time><span>{task.title}</span></button>) : <p>{t('companion.emptyAgenda')}</p>}
    </section>}
    <section className="dovun-companion-card" aria-label={t('companion.title')}>
      <div className="dovun-companion-brand"><img src={mark} alt="" /><div><h2>{t('companion.title')}</h2><p>{t('companion.greeting')}</p></div></div>
      {!compact && <p className="dovun-companion-description">{t('companion.description')}</p>}
      {settings.error ? <p role="alert" className="text-sm text-destructive">{settings.error.message}</p> : settings.isLoading ? <p role="status">{t('shell.loadingTasks')}</p> : configured ? <>
        <button className="dovun-companion-prompt" type="button" onClick={() => onAsk(t('companion.suggestion'))}><span>{t('companion.suggestion')}</span><ArrowRight size={18} /></button>
        {!compact && <button className="dovun-companion-secondary" type="button" onClick={() => onAsk(t('companion.contextSuggestion'))}><MessageSquare size={16} /><span>{t('companion.contextSuggestion')}</span><ArrowRight size={16} /></button>}
        <button className="dovun-companion-open" type="button" onClick={onOpen}>{t('companion.open')}<ArrowRight size={14} /></button>
      </> : <><p className="dovun-companion-description">{t('companion.noModel')}</p><button className="dovun-companion-prompt" type="button" onClick={onConfigure}><span>{t('companion.configure')}</span><ArrowRight size={18} /></button></>}
    </section>
  </div>;
}
