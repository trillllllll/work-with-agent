import type { FormEvent } from 'react';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Label } from '@/components/ui/label.js';
import { Textarea } from '@/components/ui/textarea.js';
import { FormDialog } from '@/components/dialogs/FormDialog.js';

type TopicModalProps = {
  form: any;
  onChange: (form: any) => void;
  onClose: () => void;
  onSave: () => void;
  onDelete?: () => void;
  busy?: boolean;
};

export function TopicModal({ form, onChange, onClose, onSave, onDelete, busy = false }: TopicModalProps) {
  const submit = (event: FormEvent) => { event.preventDefault(); onSave(); };
  return (
    <FormDialog title={form.id ? '编辑清单' : '新建清单'} description="输入名称就可以开始记录任务。" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="mb-4">
          <Label htmlFor="topic-name">清单名称</Label>
          <Input id="topic-name" required value={form.name} onChange={(event) => onChange({ ...form, name: event.target.value })} placeholder="例如：Agent 工作室" />
        </div>
        <details className="mb-4"><summary className="mb-3 cursor-pointer text-sm text-muted-foreground">探索属性与目标</summary><div className="mb-4">
          <Label htmlFor="topic-description">描述</Label>
          <Textarea id="topic-description" value={form.description ?? ''} onChange={(event) => onChange({ ...form, description: event.target.value })} placeholder="这个清单最终想形成什么结果？" />
        </div>
        <div className="mb-4"><Label htmlFor="topic-goal">目标</Label><Input id="topic-goal" value={form.goal ?? ''} onChange={(event) => onChange({ ...form, goal: event.target.value })} /></div>
        <Label htmlFor="topic-exploration" className="mb-5 flex items-center gap-2 font-normal">
          <input id="topic-exploration" type="checkbox" className="size-3.5 accent-primary" checked={form.isExploration} onChange={(event) => onChange({ ...form, isExploration: event.target.checked })} />
          当前仍在探索
        </Label></details>
        <div className="flex items-center justify-between gap-2 border-t pt-4">
          {form.id && onDelete ? <Button type="button" variant="outline" disabled={busy} onClick={onDelete}>归档清单</Button> : <span />}
          <div className="flex gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button>
          <Button disabled={busy}>{busy ? '正在保存…' : '保存清单'}</Button>
          </div>
        </div>
      </form>
    </FormDialog>
  );
}
