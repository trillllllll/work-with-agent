import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';
export type ActionPrompt = { title: string; description: string; confirm?: string; destructive?: boolean };
export function ActionDialog({ prompt, onResolve }: { prompt: ActionPrompt; onResolve: (value: boolean) => void }) {
  const { t } = useTranslation('settings');
  return <Dialog open onOpenChange={(open) => { if (!open) onResolve(false); }}><DialogContent surface="glass"><DialogHeader><DialogTitle>{prompt.title}</DialogTitle><DialogDescription className="whitespace-pre-wrap">{prompt.description}</DialogDescription></DialogHeader><div className="flex justify-end gap-2"><Button variant="outline" onClick={() => onResolve(false)}>{t('actions.cancel')}</Button><Button variant={prompt.destructive ? 'destructive' : 'default'} onClick={() => onResolve(true)}>{prompt.confirm ?? t('actions.confirm')}</Button></div></DialogContent></Dialog>;
}
