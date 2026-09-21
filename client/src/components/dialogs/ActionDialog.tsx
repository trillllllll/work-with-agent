import { Button } from '@/components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';
export type ActionPrompt = { title: string; description: string; confirm?: string; destructive?: boolean };
export function ActionDialog({ prompt, onResolve }: { prompt: ActionPrompt; onResolve: (value: boolean) => void }) {
  return <Dialog open onOpenChange={(open) => { if (!open) onResolve(false); }}><DialogContent surface="glass"><DialogHeader><DialogTitle>{prompt.title}</DialogTitle><DialogDescription className="whitespace-pre-wrap">{prompt.description}</DialogDescription></DialogHeader><div className="flex justify-end gap-2"><Button variant="outline" onClick={() => onResolve(false)}>取消</Button><Button variant={prompt.destructive ? 'destructive' : 'default'} onClick={() => onResolve(true)}>{prompt.confirm ?? '确认'}</Button></div></DialogContent></Dialog>;
}
