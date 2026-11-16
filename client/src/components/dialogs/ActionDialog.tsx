import { ConfirmDialog } from './ConfirmDialog.js';
export type ActionPrompt = { title: string; description: string; confirm?: string; destructive?: boolean };
/** Promise-style confirm prompt; renders the shared ConfirmDialog so both dialog families look and behave the same. */
export function ActionDialog({ prompt, onResolve }: { prompt: ActionPrompt; onResolve: (value: boolean) => void }) {
  return <ConfirmDialog
    title={prompt.title}
    description={prompt.description}
    confirmLabel={prompt.confirm}
    tone={prompt.destructive ? 'destructive' : 'default'}
    onCancel={() => onResolve(false)}
    onConfirm={() => onResolve(true)}
  />;
}
