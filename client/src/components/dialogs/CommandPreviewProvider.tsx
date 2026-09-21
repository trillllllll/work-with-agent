import { createContext, useContext, useRef, useState, type ReactNode } from 'react';
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
    if ('topicId' in input) {
      const topic = client.getQueriesData<any>({ queryKey: ['topics'] }).flatMap(([, rows]) => Array.isArray(rows) ? rows : []).find((row) => row.id === input.topicId);
      changes.push(`移动到${input.topicId ? `清单“${topic?.name ?? '所选清单'}”` : '收集箱'}，子任务一同移动`);
    }
    if (input.status) changes.push(`状态改为${({ todo: '待办', doing: '进行中', blocked: '已阻塞', done: '已完成' } as Record<string, string>)[String(input.status)] ?? input.status}${input.completeChildren ? '，并完成未完成的子任务' : ''}`);
    if (item.detail?.kind === 'task.create') changes.push('添加子任务并更新父任务；已完成的父任务会重开');
    if (item.detail?.kind === 'task.delete') changes.push('以下任务一起移入回收站');
    if (item.detail?.kind === 'task.restore') changes.push('恢复本次删除批次中仍在回收站的任务，原归属不可用时回到收集箱');
    if (item.detail?.kind === 'tag.delete') changes.push('解除以下任务的标签关联，保留任务');
    if ('parentId' in input && !('topicId' in input)) changes.push(input.parentId ? '更新父子关系；已完成的父任务可能重开' : '解除父子关系');
    return changes.join('；');
  };
  return <PreviewContext.Provider value={confirm}>{children}{prompt && <Dialog open onOpenChange={(open) => { if (!open) finish(false); }}><DialogContent surface="glass" className="max-h-[85dvh] overflow-y-auto"><DialogHeader><DialogTitle>确认连带修改</DialogTitle><DialogDescription>以下对象将一起修改。取消会保留当前输入；确认时若内容已变化，将拒绝整组操作。</DialogDescription></DialogHeader><div className="space-y-4">{prompt.value.preview.map((item, index) => <section key={index} className="space-y-2"><h3 className="font-semibold">{operationNames[item.detail?.kind ?? ''] ?? item.detail?.kind} · {item.detail?.before?.title ?? item.detail?.before?.name ?? '新建对象'}</h3><p className="text-sm text-muted-foreground">{describe(item)}</p><ul className="max-h-52 space-y-1 overflow-y-auto text-sm">{item.detail?.affectedTasks?.map((task) => <li key={task.id}>{task.title} <span className="text-xs text-muted-foreground">（当前版本 {task.revision}）</span></li>)}</ul><details><summary className="cursor-pointer text-sm text-muted-foreground">查看完整修改内容</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(item, null, 2)}</pre></details></section>)}</div><div className="flex justify-end gap-2"><Button variant="outline" onClick={() => finish(false)}>取消</Button><Button onClick={() => finish(true)}>确认影响并执行</Button></div></DialogContent></Dialog>}</PreviewContext.Provider>;
}
