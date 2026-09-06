import type { FormEvent } from 'react';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Label } from '@/components/ui/label.js';
import { Textarea } from '@/components/ui/textarea.js';
import { FormDialog } from '@/components/dialogs/FormDialog.js';

type TaskModalProps = {
  form: any;
  onChange: (form: any) => void;
  onClose: () => void;
  onSave: () => void;
  busy?: boolean;
};

export function TaskModal({ form, onChange, onClose, onSave, busy = false }: TaskModalProps) {
  const submit = (event: FormEvent) => { event.preventDefault(); onSave(); };
  return (
    <FormDialog title={form.id ? '编辑任务' : '新建任务'} description="补充任务背景和预期结果，保存后会同步到当前看板。" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="mb-4">
          <Label htmlFor="task-title">任务名称</Label>
          <Input id="task-title" required value={form.title} onChange={(event) => onChange({ ...form, title: event.target.value })} placeholder="下一步要完成什么？" />
        </div>
        <div className="mb-4">
          <Label htmlFor="task-description">任务描述</Label>
          <Textarea id="task-description" value={form.description} onChange={(event) => onChange({ ...form, description: event.target.value })} placeholder="补充背景、范围或验收标准" />
        </div>
        <div className="mb-5">
          <Label htmlFor="task-result">结果摘要</Label>
          <Textarea id="task-result" value={form.resultSummary} onChange={(event) => onChange({ ...form, resultSummary: event.target.value })} placeholder="完成后记录最终结果" />
        </div>
        <div className="flex justify-end gap-2 border-t pt-4">
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button>
          <Button disabled={busy}>{busy ? '正在保存…' : '保存任务'}</Button>
        </div>
      </form>
    </FormDialog>
  );
}
