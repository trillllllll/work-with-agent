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
  busy?: boolean;
};

export function TopicModal({ form, onChange, onClose, onSave, busy = false }: TopicModalProps) {
  const submit = (event: FormEvent) => { event.preventDefault(); onSave(); };
  return (
    <FormDialog title={form.id ? '编辑主题' : '新建主题'} description="主题是任务逐渐收敛成结果的容器。" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="mb-4">
          <Label htmlFor="topic-name">主题名称</Label>
          <Input id="topic-name" required value={form.name} onChange={(event) => onChange({ ...form, name: event.target.value })} placeholder="例如：Agent 工作室" />
        </div>
        <div className="mb-4">
          <Label htmlFor="topic-description">描述</Label>
          <Textarea id="topic-description" value={form.description} onChange={(event) => onChange({ ...form, description: event.target.value })} placeholder="这个主题最终想形成什么结果？" />
        </div>
        <Label htmlFor="topic-exploration" className="mb-5 flex items-center gap-2 font-normal">
          <input id="topic-exploration" type="checkbox" className="size-3.5 accent-primary" checked={form.isExploration} onChange={(event) => onChange({ ...form, isExploration: event.target.checked })} />
          当前仍在探索
        </Label>
        <div className="flex justify-end gap-2 border-t pt-4">
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button>
          <Button disabled={busy}>{busy ? '正在保存…' : '保存主题'}</Button>
        </div>
      </form>
    </FormDialog>
  );
}
