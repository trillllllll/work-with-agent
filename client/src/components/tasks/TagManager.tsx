import { TagChip } from '@/components/ui/tag-chip.js';
import { Surface } from '@/components/ui/surface.js';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { tagColors, type Tag, type TagColor } from '@/lib/api.js';
import { useTodoActions } from '@/hooks/useTodo.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import type { ActionPrompt } from '@/components/dialogs/ActionDialog.js';

function ColorSwatches({ value, onChange, labelFor }: { value: TagColor; onChange: (color: TagColor) => void; labelFor: (label: string) => string }) {
  const { t } = useTranslation('tasks');
  return <div className="flex items-center gap-1.5" role="group" aria-label={t('tagManager.colorGroup')}>{tagColors.map((color) => <Button variant="plain" size="bare" key={color.id} type="button" className="tag-color-swatch" data-color={color.id} aria-label={labelFor(color.label)} aria-pressed={value === color.id} onClick={() => onChange(color.id)} />)}</div>;
}

export function TagManager({ tags, selected, onSelect, confirm }: { tags: Tag[]; selected: string; onSelect: (id: string) => void; confirm: (prompt: ActionPrompt) => Promise<boolean> }) {
  const { t } = useTranslation('tasks');
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
      await actions.write(editing ? `/api/tags/${editing.id}` : '/api/tags', editing ? 'PATCH' : 'POST', { name: value.trim(), color: editing?.color ?? color }, [editing?.id ?? 'tag-create'], editing ? t('tagManager.updated') : t('tagManager.created'));
      if (editing) setEditing(null);
      else { setName(''); setColor('violet'); }
    } catch { /* Preserve the name for retry. */ } finally { lock.current = false; }
  };
  const recolor = (tag: Tag, next: TagColor) => {
    if (next === (tag.color || 'violet') || actions.pending) return;
    void actions.write(`/api/tags/${tag.id}`, 'PATCH', { color: next }, [tag.id], t('tagManager.colorUpdated')).catch(() => undefined);
  };
  return <div className="mb-5 space-y-3">
    <form className="flex flex-wrap items-center gap-2" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <Input aria-label={editing ? t('tagManager.editingName') : t('tagManager.name')} placeholder={t('tagManager.placeholder')} value={editing?.name ?? name} onChange={(event) => editing ? setEditing({ ...editing, name: event.target.value }) : setName(event.target.value)} />
      <ColorSwatches value={editing?.color ?? color} onChange={(next) => editing ? setEditing({ ...editing, color: next }) : setColor(next)} labelFor={(label) => editing ? t('tagManager.editingColor', { label }) : t('tagManager.newColor', { label })} />
      <Button disabled={actions.pending || !(editing?.name ?? name).trim()}>{editing ? t('tagManager.save') : t('tagManager.create')}</Button>
      {editing && <Button type="button" variant="outline" onClick={() => setEditing(null)}>{t('shared.cancel')}</Button>}
    </form>
    <div className="flex flex-wrap gap-2">{tags.map((tag) => <Surface as="div" tone="subtle" key={tag.id} className="flex flex-wrap items-center gap-1 rounded-xl p-1">
      <TagChip asChild data-color={tag.color || 'violet'}><Button variant="plain" size="bare" type="button" className="px-2.5 py-1" aria-pressed={selected === tag.id} onClick={() => onSelect(selected === tag.id ? '' : tag.id)}>#{tag.name}</Button></TagChip>
      <ColorSwatches value={tag.color || 'violet'} onChange={(next) => recolor(tag, next)} labelFor={(label) => t('tagManager.recolor', { name: tag.name, label })} />
      <Button size="sm" variant="ghost" aria-label={t('tagManager.renameAria', { name: tag.name })} onClick={() => setEditing({ id: tag.id, name: tag.name, color: tag.color || 'violet' })}>{t('tagManager.rename')}</Button>
      <Button size="sm" variant="ghost" aria-label={t('tagManager.deleteAria', { name: tag.name })} onClick={() => { void (async () => { if (await confirm({ title: t('tagManager.deleteTitle'), description: t('tagManager.deleteDescription', { name: tag.name }), confirm: t('tagManager.deleteTitle'), destructive: true })) { await actions.write(`/api/tags/${tag.id}`, 'DELETE', undefined, [tag.id], t('tagManager.deleted')); if (selected === tag.id) onSelect(''); } })().catch(() => undefined); }}>{t('tagManager.delete')}</Button>
    </Surface>)}</div>
  </div>;
}
