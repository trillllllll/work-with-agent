import { Surface } from '@/components/ui/surface.js';
import { useTranslation } from 'react-i18next';
import { RotateCcw, Trash2 } from 'lucide-react';
import type { TrashTask } from '@/lib/api.js';
import { intlLocale } from '@/i18n/index.js';
import { Button } from '@/components/ui/button.js';

type Props = { tasks: TrashTask[]; loading: boolean; onRestore: (task: TrashTask) => void; onPermanentDelete: (task: TrashTask) => void };
export function TrashPage({ tasks, loading, onRestore, onPermanentDelete }: Props) {
  const { t } = useTranslation('settings');
  return <div className="min-h-full"><header className="glass-divider border-b px-5 py-5 sm:px-8"><h1 className="text-xl font-semibold tracking-tight">{t('trash.title')}</h1><p className="mt-1 text-xs text-muted-foreground">{t('trash.description')}</p></header><div className="p-5 sm:p-8"><div className="mx-auto flex max-w-3xl flex-col gap-3">{loading ? <p className="py-10 text-center text-sm text-muted-foreground">{t('trash.loading')}</p> : !tasks.length ? <div className="py-16 text-center"><Trash2 className="mx-auto size-10 text-muted-foreground/40" /><p className="mt-3 text-sm text-muted-foreground">{t('trash.empty')}</p></div> : tasks.map((task) => <Surface as="article" tone="subtle" key={task.id} className="rounded-2xl p-4 transition-colors hover:bg-[var(--glass-hover)]"><div className="flex items-start justify-between gap-4 max-md:flex-col"><div className="min-w-0"><h2 className="truncate text-sm font-semibold">{task.title}</h2><p className="mt-1 text-xs text-muted-foreground">{t('trash.meta', { topic: task.topic?.name ?? t('trash.inbox'), status: task.status, deletedAt: new Date(task.deletedAt).toLocaleString(intlLocale()) })}</p>{task.description && <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{task.description}</p>}</div><div className="flex shrink-0 gap-2"><Button variant="outline" size="sm" onClick={() => onRestore(task)}><RotateCcw />{t('trash.restore')}</Button><Button variant="destructive" size="sm" onClick={() => onPermanentDelete(task)}><Trash2 />{t('trash.permanentDelete')}</Button></div></div></Surface>)}</div></div></div>;
}
