import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, FileUp, Plus } from 'lucide-react';
import { api, ApiError } from '@/lib/api.js';
import { usePageContext } from '@/lib/assistant-context.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog.js';
import { MarkdownView } from '@/components/chat/MarkdownView.js';
import { cn } from '@/lib/utils.js';
import { SkillHistory } from './SkillHistory.js';
import { openSkillEditor, skillImportErrorText, skillOriginLabel, type SkillDetail, type SkillListItem } from './skill-format.js';

type StatusFilter = 'all' | 'enabled' | 'disabled' | 'deleted';
type ImportConflict = { markdown: string; draft: { name: string; description: string }; skillId: string; revision: number };

function listPath(q: string, status: StatusFilter, origin: string) {
  const params = new URLSearchParams();
  if (q.trim()) params.set('q', q.trim());
  if (status === 'enabled') params.set('enabled', 'true');
  if (status === 'disabled') params.set('enabled', 'false');
  if (status === 'deleted') params.set('deleted', 'true');
  if (origin) params.set('origin', origin);
  const query = params.toString();
  return `/api/skills${query ? `?${query}` : ''}`;
}

function ImportConflictDialog({ conflict, onClose, onDone }: { conflict: ImportConflict; onClose: () => void; onDone: (skill: SkillDetail) => void }) {
  const [name, setName] = useState(`${conflict.draft.name}（导入）`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (resolution: 'version' | 'rename') => {
    setBusy(true);
    setError('');
    try {
      const body = resolution === 'version' ? { markdown: conflict.markdown, resolution, expectedRevision: conflict.revision } : { markdown: conflict.markdown, resolution, name: name.trim() };
      onDone(await api<SkillDetail>('/api/skills/import', { method: 'POST', body: JSON.stringify(body) }));
    } catch (failure) {
      setError(failure instanceof ApiError && failure.code === 'SKILL_NAME_TAKEN' ? '这个名称也已被占用，请换一个。' : failure instanceof Error ? failure.message : '导入失败');
    } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent surface="glass" data-testid="skill-import-conflict">
        <DialogHeader><DialogTitle>已有同名技能「{conflict.draft.name}」</DialogTitle><DialogDescription>可以把导入内容存为它的新版本，也可以改名另存为一个新技能。</DialogDescription></DialogHeader>
        <label className="grid gap-1 text-sm">新名称<Input aria-label="导入后的名称" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} /></label>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>取消</Button>
          <Button variant="outline" disabled={busy || !name.trim()} onClick={() => void submit('rename')}>改名另存</Button>
          <Button disabled={busy} onClick={() => void submit('version')}>覆盖为新版本</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SkillDetailView({ id, onBack }: { id: string; onBack: () => void }) {
  const client = useQueryClient();
  const detail = useQuery({ queryKey: ['skill', id], queryFn: () => api<SkillDetail>(`/api/skills/${id}`) });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const skill = detail.data;
  const refresh = async () => { await client.invalidateQueries({ queryKey: ['skills'] }); await client.invalidateQueries({ queryKey: ['skill', id] }); };
  const act = async (work: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try { await work(); await refresh(); toast.success(message); return true; }
    catch (failure) { toast.error(failure instanceof Error ? failure.message : '操作失败'); await refresh(); return false; }
    finally { setBusy(false); }
  };
  if (detail.error) return <p role="alert" className="p-4 text-sm text-destructive">{detail.error.message}</p>;
  if (!skill) return <p className="p-4 text-sm text-muted-foreground">正在加载…</p>;
  return (
    <article className="grid gap-4" aria-label={`技能：${skill.name}`} data-testid="skill-detail">
      <Button variant="ghost" size="sm" className="justify-self-start md:hidden" onClick={onBack}><ArrowLeft />返回列表</Button>
      <header className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-semibold break-words">{skill.name}</h2>
          <p className="mt-1 text-xs text-muted-foreground">v{skill.revision} · {skillOriginLabel(skill.origin)} · {skill.deletedAt ? '已删除' : skill.enabled ? '已启用' : '已停用'} · 更新于 {new Date(skill.updatedAt).toLocaleString()}</p>
        </div>
        {skill.deletedAt
          ? <Button size="sm" disabled={busy} onClick={() => void act(() => api(`/api/skills/${skill.id}/restore`, { method: 'POST', body: '{}' }), '技能已恢复')}>恢复</Button>
          : <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => openSkillEditor({ skillId: skill.id })}>编辑</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirmDelete(true)}>删除</Button></div>}
      </header>
      <p className="text-sm">{skill.description}</p>
      <div className="glass-subtle rounded-xl p-4" data-testid="skill-instructions"><MarkdownView content={skill.instructions} /></div>
      <SkillHistory skill={skill} />
      {confirmDelete && <ConfirmDialog title="删除技能" itemName={skill.name} description="删除后助手不会再看到它。版本历史会保留，可以在筛选「已删除」里恢复。" busy={busy} onCancel={() => setConfirmDelete(false)} onConfirm={() => void act(() => api(`/api/skills/${skill.id}?expectedRevision=${skill.revision}`, { method: 'DELETE' }), '技能已删除').then((ok) => { setConfirmDelete(false); if (ok) onBack(); })} />}
    </article>
  );
}

export function SkillsPage() {
  const client = useQueryClient();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [origin, setOrigin] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [conflict, setConflict] = useState<ImportConflict | null>(null);
  const [toggling, setToggling] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  usePageContext('skills', { pageState: { status, kind: origin, query: q, selectedId } });
  const list = useQuery({ queryKey: ['skills', q, status, origin], queryFn: () => api<SkillListItem[]>(listPath(q, status, origin)) });
  const skills = list.data ?? [];

  const toggle = async (skill: SkillListItem) => {
    setToggling(skill.id);
    try {
      await api(`/api/skills/${skill.id}`, { method: 'PATCH', body: JSON.stringify({ expectedRevision: skill.revision, enabled: !skill.enabled }) });
      toast.success(skill.enabled ? '技能已停用' : '技能已启用');
    } catch (failure) {
      toast.error(failure instanceof ApiError && failure.code === 'VERSION_CONFLICT' ? '这个技能已被其他窗口修改，已刷新' : failure instanceof Error ? failure.message : '操作失败');
    } finally {
      setToggling('');
      await client.invalidateQueries({ queryKey: ['skills'] });
      await client.invalidateQueries({ queryKey: ['skill', skill.id] });
    }
  };

  const imported = async (skill: SkillDetail) => {
    setConflict(null);
    await client.invalidateQueries({ queryKey: ['skills'] });
    await client.invalidateQueries({ queryKey: ['skill', skill.id] });
    setSelectedId(skill.id);
    toast.success(skill.revision === 1 ? '已导入为新技能' : `已导入为 v${skill.revision}`);
  };

  const importFile = async (file: File) => {
    const markdown = await file.text();
    try {
      await imported(await api<SkillDetail>('/api/skills/import', { method: 'POST', body: JSON.stringify({ markdown }) }));
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === 'SKILL_NAME_TAKEN') {
        const details = (failure.details ?? {}) as { skillId?: string; revision?: number; draft?: { name: string; description: string } };
        if (details.skillId && details.revision && details.draft) { setConflict({ markdown, draft: details.draft, skillId: details.skillId, revision: details.revision }); return; }
      }
      if (failure instanceof ApiError && failure.code === 'SKILL_MARKDOWN_INVALID') { toast.error(skillImportErrorText(failure)); return; }
      toast.error(failure instanceof Error ? failure.message : '导入失败');
    }
  };

  return (
    <section className="mx-auto grid max-w-6xl content-start gap-4 p-5 sm:p-7" aria-label="技能">
      <header className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold">技能</h1>
          <p className="mt-2 text-sm text-muted-foreground">把常用做法写成技能。助手只看到启用技能的名称和描述，用到时再读取正文。</p>
        </div>
        <Button variant="outline" onClick={() => fileRef.current?.click()}><FileUp />导入 SKILL.md</Button>
        <Button onClick={() => openSkillEditor({})}><Plus />新建</Button>
        <input ref={fileRef} type="file" accept=".md,text/markdown,text/plain" className="hidden" data-testid="skill-import-input" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importFile(file); }} />
      </header>
      <div className="flex flex-wrap gap-2">
        <Input aria-label="搜索技能" placeholder="搜索名称或描述" className="min-w-48 flex-1" value={q} onChange={(event) => setQ(event.target.value)} />
        <select aria-label="技能状态" className="glass-control h-9 rounded-lg px-3 text-sm" value={status} onChange={(event) => { setStatus(event.target.value as StatusFilter); setSelectedId(''); }}>
          <option value="all">全部</option><option value="enabled">已启用</option><option value="disabled">已停用</option><option value="deleted">已删除</option>
        </select>
        <select aria-label="技能来源" className="glass-control h-9 rounded-lg px-3 text-sm" value={origin} onChange={(event) => setOrigin(event.target.value)}>
          <option value="">全部来源</option><option value="manual">手写</option><option value="import">导入</option><option value="assistant">助手</option>
        </select>
      </div>
      <div className="grid min-h-0 gap-5 md:grid-cols-[minmax(240px,320px)_minmax(0,1fr)]">
        <div className={cn('min-w-0', selectedId && 'hidden md:block')}>
          {list.error && <p role="alert" className="text-sm text-destructive">{list.error.message}</p>}
          {list.isLoading ? <p className="text-sm text-muted-foreground">正在加载…</p> : !skills.length ? <p className="py-8 text-sm text-muted-foreground">{status === 'deleted' ? '没有已删除的技能。' : q || origin || status !== 'all' ? '没有符合条件的技能。' : '还没有技能。可以新建、导入 SKILL.md，或在聊天里让助手起草。'}</p> : (
            <ul aria-label="技能列表" className="glass-subtle divide-y divide-[var(--glass-divider)] overflow-hidden rounded-xl">
              {skills.map((skill) => (
                <li key={skill.id} data-testid="skill-row" data-skill-name={skill.name} className={cn('flex items-start gap-2 px-3 py-2.5', selectedId === skill.id && 'bg-[color-mix(in_srgb,var(--foreground)_8%,transparent)]')}>
                  <button type="button" className="min-w-0 flex-1 text-left" aria-current={selectedId === skill.id ? 'true' : undefined} onClick={() => setSelectedId(skill.id)}>
                    <span className="flex items-center gap-2"><span className="truncate font-medium">{skill.name}</span><span className="shrink-0 text-[11px] text-muted-foreground">v{skill.revision}</span></span>
                    <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">{skill.description}</span>
                    <span className="mt-1 block text-[11px] text-muted-foreground">{skillOriginLabel(skill.origin)} · {new Date(skill.updatedAt).toLocaleDateString()}</span>
                  </button>
                  {!skill.deletedAt && <label className="flex shrink-0 items-center gap-1 pt-0.5 text-xs text-muted-foreground"><input type="checkbox" role="switch" aria-label={`启用 ${skill.name}`} checked={skill.enabled} disabled={toggling === skill.id} onChange={() => void toggle(skill)} />{skill.enabled ? '启用' : '停用'}</label>}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className={cn('min-w-0', !selectedId && 'hidden md:block')}>
          {selectedId ? <SkillDetailView key={selectedId} id={selectedId} onBack={() => setSelectedId('')} /> : <p className="py-8 text-sm text-muted-foreground">选择一个技能查看正文和版本历史。</p>}
        </div>
      </div>
      {conflict && <ImportConflictDialog conflict={conflict} onClose={() => setConflict(null)} onDone={(skill) => void imported(skill)} />}
    </section>
  );
}
