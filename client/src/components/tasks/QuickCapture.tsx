import { forwardRef, useImperativeHandle, useRef, useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import { Input } from '@/components/ui/input.js';
import { Button } from '@/components/ui/button.js';
import { captureDraftKey, isCompositionKey } from '@/lib/todo.js';

type Props = { topicId: string | null; parentId?: string | null; onCreate: (input: { title: string; topicId: string | null; parentId: string | null }) => Promise<unknown>; inbox?: boolean; disabled?: boolean; variant?: 'bar' | 'row' };
export type QuickCaptureHandle = { focus: () => void };
function storedDraft(key: string) { try { return sessionStorage.getItem(key) ?? ''; } catch { return ''; } }
function storeDraft(key: string, value: string) { try { if (value) sessionStorage.setItem(key, value); else sessionStorage.removeItem(key); } catch { /* Storage may be unavailable in a private browser. */ } }

export const QuickCapture = forwardRef<QuickCaptureHandle, Props>(function QuickCapture({ topicId, parentId = null, onCreate, inbox, disabled, variant = 'bar' }, ref) {
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
  const name = parentId ? '子任务名称' : inbox ? '收集任务名称' : '任务名称';
  const placeholder = parentId ? '添加一个子任务…' : '下一步要做什么？';
  const submitLabel = saving ? '正在添加…' : parentId ? '添加子任务' : inbox ? '收集任务' : '添加任务';
  const field = <Input ref={input} value={title} aria-label={name} placeholder={placeholder} disabled={disabled} onChange={(event) => { setTitle(event.target.value); storeDraft(key, event.target.value); }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={(event) => { if (event.key === 'Enter' && (composing.current || isCompositionKey(event.nativeEvent))) event.preventDefault(); }} />;
  if (variant === 'row') return <form onSubmit={submit} className="quick-capture-row mb-2 flex min-h-12 items-center gap-2 rounded-xl px-2.5 py-1" aria-label={parentId ? '添加子任务' : '快速录入'}>{field}<Button type="submit" variant="ghost" size="icon-sm" aria-label={submitLabel} disabled={saving || disabled || !title.trim()}><Plus /></Button></form>;
  return <form onSubmit={submit} className="quick-capture glass-control flex gap-2 rounded-2xl p-2" aria-label={parentId ? '添加子任务' : '快速录入'}>{field}<Button type="submit" disabled={saving || disabled || !title.trim()}><Plus /><span className="max-sm:sr-only">{submitLabel}</span></Button></form>;
});
