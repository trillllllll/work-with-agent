import { createContext, useContext, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { operationNames } from '@/lib/platform.js';
import { Button } from '@/components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';

type Impact = { detail?: { kind?: string; before?: { title?: string; name?: string }; input?: Record<string, unknown>; affectedTasks?: { id: string; title: string; revision: number; status: string }[] }; after?: unknown };
export type CommandPreview = { previewToken: string; requiresConfirmation: boolean; preview: Impact[] };
type Prompt = { value: CommandPreview; resolve: (answer: boolean) => void };
const PreviewContext = createContext<(preview: CommandPreview) => Promise<boolean>>(async () => false);
export const useCommandPreview = () => useContext(PreviewContext);

export function CommandPreviewProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation('settings');
  const client = useQueryClient();
  const queue = useRef<Prompt[]>([]);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const confirm = (value: CommandPreview) => new Promise<boolean>((resolve) => {
    queue.current.push({ value, resolve });
    if (queue.current.length === 1) setPrompt(queue.current[0]);
  });
  const finish = (answer: boolean) => {
    queue.current.shift()?.resolve(answer);
    setPrompt(queue.current[0] ?? null);
  };
  const describe = (item: Impact) => {
    const input = item.detail?.input ?? {};
    const changes: string[] = [];
    const statuses: Record<string, string> = { todo: t('commandPreview.statuses.todo'), doing: t('commandPreview.statuses.doing'), blocked: t('commandPreview.statuses.blocked'), done: t('commandPreview.statuses.done') };
    if ('topicId' in input) {
      const topic = client.getQueriesData<any>({ queryKey: ['topics'] }).flatMap(([, rows]) => Array.isArray(rows) ? rows : []).find((row) => row.id === input.topicId);
      changes.push(input.topicId ? t('commandPreview.moveToList', { name: topic?.name ?? t('commandPreview.selectedList') }) : t('commandPreview.moveToInbox'));
    }
    if (input.status) {
      const status = statuses[String(input.status)] ?? String(input.status);
      changes.push(t(input.completeChildren ? 'commandPreview.statusWithChildren' : 'commandPreview.statusChange', { status }));
    }
    if (item.detail?.kind === 'task.create') changes.push(t('commandPreview.addSubtask'));
    if (item.detail?.kind === 'task.delete') changes.push(t('commandPreview.deleteTasks'));
    if (item.detail?.kind === 'task.restore') changes.push(t('commandPreview.restoreTasks'));
    if (item.detail?.kind === 'tag.delete') changes.push(t('commandPreview.removeTag'));
    if ('parentId' in input && !('topicId' in input)) changes.push(t(input.parentId ? 'commandPreview.updateParent' : 'commandPreview.clearParent'));
    return changes.join(t('commandPreview.joiner'));
  };
  return <PreviewContext.Provider value={confirm}>{children}{prompt && <Dialog open onOpenChange={(open) => { if (!open) finish(false); }}><DialogContent surface="glass" className="max-h-[85dvh] overflow-y-auto"><DialogHeader><DialogTitle>{t('commandPreview.title')}</DialogTitle><DialogDescription>{t('commandPreview.description')}</DialogDescription></DialogHeader><div className="space-y-4">{prompt.value.preview.map((item, index) => <section key={index} className="space-y-2"><h3 className="font-semibold">{operationNames[item.detail?.kind ?? ''] ?? item.detail?.kind} · {item.detail?.before?.title ?? item.detail?.before?.name ?? t('commandPreview.newObject')}</h3><p className="text-sm text-muted-foreground">{describe(item)}</p><ul className="max-h-52 space-y-1 overflow-y-auto text-sm">{item.detail?.affectedTasks?.map((task) => <li key={task.id}>{task.title} <span className="text-xs text-muted-foreground">{t('commandPreview.currentRevision', { revision: task.revision })}</span></li>)}</ul><details className="disclosure"><summary className="cursor-pointer text-sm text-muted-foreground">{t('commandPreview.viewFull')}</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(item, null, 2)}</pre></details></section>)}</div><div className="flex justify-end gap-2"><Button variant="outline" onClick={() => finish(false)}>{t('actions.cancel')}</Button><Button onClick={() => finish(true)}>{t('commandPreview.confirm')}</Button></div></DialogContent></Dialog>}</PreviewContext.Provider>;
}
