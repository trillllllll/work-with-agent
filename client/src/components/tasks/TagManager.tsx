import { useRef, useState } from 'react';
import { tagColors, type Tag, type TagColor } from '@/lib/api.js';
import { useTodoActions } from '@/hooks/useTodo.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import type { ActionPrompt } from '@/components/dialogs/ActionDialog.js';

function ColorSwatches({ value, onChange, labelFor }: { value: TagColor; onChange: (color: TagColor) => void; labelFor: (label: string) => string }) {
  return <div className="flex items-center gap-1.5" role="group" aria-label="标签颜色">{tagColors.map((color) => <button key={color.id} type="button" className="tag-color-swatch" data-color={color.id} aria-label={labelFor(color.label)} aria-pressed={value === color.id} onClick={() => onChange(color.id)} />)}</div>;
}

export function TagManager({ tags, selected, onSelect, confirm }: { tags: Tag[]; selected: string; onSelect: (id: string) => void; confirm: (prompt: ActionPrompt) => Promise<boolean> }) {
  const actions = useTodoActions();
  const [name, setName] = useState('');
  const [color, setColor] = useState<TagColor>('violet');
  const [editing, setEditing] = useState<{ id: string; name: string; color: TagColor } | null>(null);
  const lock = useRef(false);
  const save = async () => {
    const value = editing?.name ?? name;
    if (!value.trim() || lock.current) return;
    lock.current = true;
    try {
      await actions.write(editing ? `/api/tags/${editing.id}` : '/api/tags', editing ? 'PATCH' : 'POST', { name: value.trim(), color: editing?.color ?? color }, [editing?.id ?? 'tag-create'], editing ? '标签已更新' : '标签已创建');
      if (editing) setEditing(null);
      else { setName(''); setColor('violet'); }
    } catch { /* Preserve the name for retry. */ } finally { lock.current = false; }
  };
  const recolor = (tag: Tag, next: TagColor) => {
    if (next === (tag.color || 'violet') || actions.pending) return;
    void actions.write(`/api/tags/${tag.id}`, 'PATCH', { color: next }, [tag.id], '标签颜色已更新').catch(() => undefined);
  };
  return <div className="mb-5 space-y-3">
    <form className="flex flex-wrap items-center gap-2" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <Input aria-label={editing ? '标签新名称' : '标签名称'} placeholder="输入标签名称" value={editing?.name ?? name} onChange={(event) => editing ? setEditing({ ...editing, name: event.target.value }) : setName(event.target.value)} />
      <ColorSwatches value={editing?.color ?? color} onChange={(next) => editing ? setEditing({ ...editing, color: next }) : setColor(next)} labelFor={(label) => editing ? `编辑中的标签颜色：${label}` : `新建标签颜色：${label}`} />
      <Button disabled={actions.pending || !(editing?.name ?? name).trim()}>{editing ? '保存标签' : '创建标签'}</Button>
      {editing && <Button type="button" variant="outline" onClick={() => setEditing(null)}>取消</Button>}
    </form>
    <div className="flex flex-wrap gap-2">{tags.map((tag) => <div key={tag.id} className="glass-subtle flex flex-wrap items-center gap-1 rounded-xl p-1">
      <button type="button" className="task-tag-chip px-2.5 py-1" data-color={tag.color || 'violet'} aria-pressed={selected === tag.id} onClick={() => onSelect(selected === tag.id ? '' : tag.id)}>#{tag.name}</button>
      <ColorSwatches value={tag.color || 'violet'} onChange={(next) => recolor(tag, next)} labelFor={(label) => `把“${tag.name}”改成${label}`} />
      <Button size="sm" variant="ghost" aria-label={`改名标签：${tag.name}`} onClick={() => setEditing({ id: tag.id, name: tag.name, color: tag.color || 'violet' })}>改名</Button>
      <Button size="sm" variant="ghost" aria-label={`删除标签：${tag.name}`} onClick={() => { void (async () => { if (await confirm({ title: '删除标签', description: `删除“${tag.name}”只会解除关联，不会删除任务。`, confirm: '删除标签', destructive: true })) { await actions.write(`/api/tags/${tag.id}`, 'DELETE', undefined, [tag.id], '标签已删除'); if (selected === tag.id) onSelect(''); } })().catch(() => undefined); }}>删除</Button>
    </div>)}</div>
  </div>;
}
