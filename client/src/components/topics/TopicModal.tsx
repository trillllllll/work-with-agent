import { Disclosure, DisclosureTrigger } from '@/components/ui/disclosure.js';
import { Checkbox } from '@/components/ui/checkbox.js';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { tagColors } from '@/lib/api.js';
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
  const { t } = useTranslation('settings');
  const submit = (event: FormEvent) => { event.preventDefault(); onSave(); };
  return (
    <FormDialog title={form.id ? t('topicModal.editTitle') : t('topicModal.createTitle')} description={t('topicModal.description')} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="mb-4">
          <Label htmlFor="topic-name">{t('topicModal.name')}</Label>
          <Input id="topic-name" required value={form.name} onChange={(event) => onChange({ ...form, name: event.target.value })} placeholder={t('topicModal.namePlaceholder')} />
        </div>
        <div className="mb-4">
          <Label>{t('topicModal.color')}</Label>
          <div className="flex items-center gap-1.5" role="group" aria-label={t('topicModal.colorGroup')}>{tagColors.map((color) => <Button variant="plain" size="bare" key={color.id} type="button" className="tag-color-swatch" data-color={color.id} aria-label={color.label} aria-pressed={(form.color || 'slate') === color.id} onClick={() => onChange({ ...form, color: color.id })} />)}</div>
        </div>
        <Disclosure className="disclosure mb-4"><DisclosureTrigger className="mb-3 cursor-pointer text-sm text-muted-foreground">{t('topicModal.exploration')}</DisclosureTrigger><div className="mb-4">
          <Label htmlFor="topic-description">{t('topicModal.descriptionLabel')}</Label>
          <Textarea id="topic-description" value={form.description ?? ''} onChange={(event) => onChange({ ...form, description: event.target.value })} placeholder={t('topicModal.descriptionPlaceholder')} />
        </div>
        <div className="mb-4"><Label htmlFor="topic-goal">{t('topicModal.goal')}</Label><Input id="topic-goal" value={form.goal ?? ''} onChange={(event) => onChange({ ...form, goal: event.target.value })} /></div>
        <Label htmlFor="topic-exploration" className="mb-5 flex items-center gap-2 font-normal">
          <Checkbox id="topic-exploration"  className="size-3.5 accent-primary" checked={form.isExploration} onChange={(event) => onChange({ ...form, isExploration: event.target.checked })} />
          {t('topicModal.stillExploring')}
        </Label></Disclosure>
        <div className="flex items-center justify-between gap-2 border-t pt-4">
          {form.id && onDelete ? <Button type="button" variant="outline" disabled={busy} onClick={onDelete}>{t('topicModal.archive')}</Button> : <span />}
          <div className="flex gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>{t('actions.cancel')}</Button>
          <Button disabled={busy}>{busy ? t('topicModal.saving') : t('topicModal.save')}</Button>
          </div>
        </div>
      </form>
    </FormDialog>
  );
}
