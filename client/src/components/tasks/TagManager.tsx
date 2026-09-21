import { useRef, useState } from 'react';
import type { Tag } from '@/lib/api.js';
import { useTodoActions } from '@/hooks/useTodo.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import type { ActionPrompt } from '@/components/dialogs/ActionDialog.js';

export function TagManager({ tags, selected, onSelect, confirm }: { tags: Tag[]; selected: string; onSelect: (id: string) => void; confirm: (prompt: ActionPrompt) => Promise<boolean> }) {
  const actions = useTodoActions();
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const lock = useRef(false);
  const save = async () => {
    const value = editing?.name ?? name;
    if (!value.trim() || lock.current) return;
    lock.current = true;
    try {
      await actions.write(editing ? `/api/tags/${editing.id}` : '/api/tags', editing ? 'PATCH' : 'POST', { name: value.trim() }, [editing?.id ?? 'tag-create'], editing ? '标签已改名' : '标签已创建');
      editing ? setEditing(null) : setName('');
    } catch { /* Preserve the name for retry. */ } finally { lock.current = false; }
  };
  return <div className="mb-5 space-y-3"><form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void save(); }}><Input aria-label={editing ? '标签新名称' : '标签名称'} placeholder="输入标签名称" value={editing?.name ?? name} onChange={(event) => editing ? setEditing({ ...editing, name: event.target.value }) : setName(event.target.value)} /><Button disabled={actions.pending || !(editing?.name ?? name).trim()}>{editing ? '保存标签' : '创建标签'}</Button>{editing && <Button type="button" variant="outline" onClick={() => setEditing(null)}>取消</Button>}</form><div className="flex flex-wrap gap-2">{tags.map((tag) => <div key={tag.id} className="glass-subtle flex items-center rounded-xl p-1"><Button size="sm" variant={selected === tag.id ? 'default' : 'ghost'} onClick={() => onSelect(selected === tag.id ? '' : tag.id)}>#{tag.name}</Button><Button size="sm" variant="ghost" aria-label={`改名标签：${tag.name}`} onClick={() => setEditing(tag)}>改名</Button><Button size="sm" variant="ghost" aria-label={`删除标签：${tag.name}`} onClick={() => { void (async () => { if (await confirm({ title: '删除标签', description: `删除“${tag.name}”只会解除关联，不会删除任务。`, confirm: '删除标签', destructive: true })) { await actions.write(`/api/tags/${tag.id}`, 'DELETE', undefined, [tag.id], '标签已删除'); if (selected === tag.id) onSelect(''); } })().catch(() => undefined); }}>删除</Button></div>)}</div></div>;
}
