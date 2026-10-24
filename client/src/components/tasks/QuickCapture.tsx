import { Surface } from '@/components/ui/surface.js';
import { forwardRef, useImperativeHandle, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { Input } from '@/components/ui/input.js';
import { Button } from '@/components/ui/button.js';
import { captureDraftKey, isCompositionKey } from '@/lib/todo.js';

type Props = { topicId: string | null; parentId?: string | null; onCreate: (input: { title: string; topicId: string | null; parentId: string | null }) => Promise<unknown>; inbox?: boolean; disabled?: boolean; variant?: 'bar' | 'row' };
export type QuickCaptureHandle = { focus: () => void };
function storedDraft(key: string) { try { return sessionStorage.getItem(key) ?? ''; } catch { return ''; } }
function storeDraft(key: string, value: string) { try { if (value) sessionStorage.setItem(key, value); else sessionStorage.removeItem(key); } catch { /* Storage may be unavailable in a private browser. */ } }

export const QuickCapture = forwardRef<QuickCaptureHandle, Props>(function QuickCapture({ topicId, parentId = null, onCreate, inbox, disabled, variant = 'bar' }, ref) {
  const { t } = useTranslation('tasks');
  const key = captureDraftKey(topicId, parentId);
  const [title, setTitle] = useState(() => storedDraft(key));
  const [saving, setSaving] = useState(false);
  const lock = useRef(false);
  const composing = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }), []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (lock.current || composing.current || disabled || !title.trim()) return;
    lock.current = true;
    setSaving(true);
    const submitted = title;
    try {
      await onCreate({ title: submitted.trim(), topicId, parentId });
      if (storedDraft(key) === submitted) storeDraft(key, '');
      setTitle((current) => current === submitted ? '' : current);
      input.current?.focus();
    } catch { /* The shared mutation shows the error; preserve this scope's draft. */ }
    finally { lock.current = false; setSaving(false); }
  };
  const name = parentId ? t('quickCapture.subtaskName') : inbox ? t('quickCapture.inboxTaskName') : t('quickCapture.taskName');
  const placeholder = parentId ? t('quickCapture.subtaskPlaceholder') : t('quickCapture.nextPlaceholder');
  const submitLabel = saving ? t('quickCapture.adding') : parentId ? t('quickCapture.addSubtask') : inbox ? t('quickCapture.captureTask') : t('quickCapture.addTask');
  const formLabel = parentId ? t('quickCapture.addSubtask') : t('quickCapture.quickAdd');
  const field = <Input variant={variant === 'bar' ? 'inline' : 'default'} ref={input} className={variant === 'bar' ? 'h-9 w-full min-w-0 flex-1 px-3 py-1 text-sm' : 'min-w-0 flex-1'} value={title} aria-label={name} placeholder={placeholder} disabled={disabled} onChange={(event) => { setTitle(event.target.value); storeDraft(key, event.target.value); }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={(event) => { if (event.key === 'Enter' && (composing.current || isCompositionKey(event.nativeEvent))) event.preventDefault(); }} />;
  if (variant === 'row') return <form onSubmit={submit} className="quick-capture-row mb-2 flex min-h-12 items-center gap-2 rounded-xl px-2.5 py-1" aria-label={formLabel}>{field}<Button type="submit" variant="ghost" size="icon-sm" aria-label={submitLabel} disabled={saving || disabled || !title.trim()}><Plus /></Button></form>;
  return <Surface as="form" tone="input" onSubmit={submit} className="quick-capture flex items-center gap-1 rounded-xl px-2 py-1.5 transition-colors focus-within:bg-[var(--glass-control)]" aria-label={formLabel}><Plus className="ml-1 size-4 shrink-0 text-muted-foreground" aria-hidden />{field}<Button type="submit" variant="ghost" size="sm" disabled={saving || disabled || !title.trim()}><span className="max-sm:sr-only">{submitLabel}</span></Button></Surface>;
});
