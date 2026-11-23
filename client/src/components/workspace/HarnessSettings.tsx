import { useState } from 'react';
import { ChevronDown, ListChecks, SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.js';
import { ChoiceList } from '@/components/ui/choice-list.js';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog.js';
import { Input } from '@/components/ui/input.js';
import type { HarnessSettingsChange, HarnessSettingsView } from '../../../../server/src/node-agent/harness-protocol.js';

export function HarnessSettings({ settings, disabled, saving, error, modelOnly = false, onChange, onForkProvider }: {
  settings: HarnessSettingsView;
  disabled: boolean;
  saving: boolean;
  error: string | null;
  modelOnly?: boolean;
  onChange: (changes: HarnessSettingsChange) => void;
  onForkProvider?: (provider: string) => void;
}) {
  const { t } = useTranslation('workspace');
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState('');
  const selected = settings.models.find((model) => model.id === settings.model);
  const modelName = selected?.label ?? settings.model;
  const models = selected ? settings.models : [{ id: settings.model, label: modelName }, ...settings.models];
  const search = query.trim().toLocaleLowerCase();
  const filtered = models.filter((model) => (model.label + ' ' + model.id).toLocaleLowerCase().includes(search));
  const effortName = (id: string) => t('harness.settings.efforts.' + id, { defaultValue: id });

  return <Dialog onOpenChange={(open) => { if (!open) { setQuery(''); setProvider(''); } }}>
    <DialogTrigger asChild>
      <Button type="button" variant="ghost" size="sm"
        className="min-h-11 max-w-[40vw] shrink-0 justify-start gap-1.5 px-2 sm:max-w-56"
        aria-label={t('harness.settings.title')} title={modelName} disabled={disabled}>
        {settings.mode === 'plan' ? <ListChecks aria-hidden="true" className="size-3.5" /> : <SlidersHorizontal aria-hidden="true" className="size-3.5" />}
        <span className="min-w-0 truncate">{modelName}</span>
        <ChevronDown aria-hidden="true" className="size-3" />
      </Button>
    </DialogTrigger>
    <DialogContent className="flex max-h-[85dvh] flex-col overflow-hidden">
      <DialogHeader>
        <DialogTitle>{t('harness.settings.title')}</DialogTitle>
        <DialogDescription>{t('harness.settings.nextTurn')}</DialogDescription>
      </DialogHeader>
      <div className="glass-scrollbar min-h-0 space-y-4 overflow-y-auto">
        {models.length > 10 && <Input value={query} onChange={(event) => setQuery(event.target.value)}
          aria-label={t('harness.settings.search')} placeholder={t('harness.settings.search')} />}
        {filtered.length ? <div className="glass-scrollbar max-h-52 overflow-y-auto">
          <ChoiceList label={t('harness.settings.model')} options={filtered} value={settings.model} disabled={disabled}
            onChange={(model) => onChange({ model })} />
        </div> : <p role="status" className="text-sm text-muted-foreground">{t('harness.settings.noMatch')}</p>}
        {!settings.catalogAvailable && <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-muted-foreground">{t('harness.settings.catalogUnavailable')}</p>
          <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => onChange({})}>{t('harness.retry')}</Button>
        </div>}
        {!modelOnly && selected?.efforts.length ? <ChoiceList label={t('harness.settings.effort')} value={settings.effort ?? ''}
          options={selected.efforts.map((id) => ({ id, label: effortName(id) }))}
          onChange={(effort) => onChange({ effort })} disabled={disabled} /> : null}
        {!modelOnly && (settings.planAvailable || settings.mode === 'plan') && <ChoiceList label={t('harness.settings.mode')} value={settings.mode}
          options={[
            { id: 'default', label: t('harness.settings.defaultMode') },
            { id: 'plan', label: t('harness.settings.planMode'), description: t('harness.settings.planHint') },
          ]}
          onChange={(mode) => onChange({ mode: mode === 'plan' ? 'plan' : 'default' })} disabled={disabled} />}
        {!modelOnly && <ChoiceList label={t('harness.settings.permission')} value={settings.permission}
          options={[
            { id: 'readOnly', label: t('harness.settings.readOnly') },
            { id: 'workspace', label: t('harness.settings.workspace'), description: t('harness.settings.workspaceHint') },
          ]}
          onChange={(permission) => onChange({ permission: permission === 'readOnly' ? 'readOnly' : 'workspace' })} disabled={disabled} />}
        {onForkProvider && (settings.providers?.length ?? 0) > 1 && <>
          <ChoiceList label={t('harness.settings.provider')} value={provider || settings.provider || ''}
            options={settings.providers!.map((id) => ({ id, label: id }))} onChange={setProvider} disabled={disabled} />
          {provider && provider !== settings.provider && <Button type="button" variant="outline" disabled={disabled}
            onClick={() => onForkProvider(provider)}>{t('harness.settings.forkProvider')}</Button>}
        </>}
      </div>
      {saving && <p role="status" className="text-sm text-muted-foreground">{t('harness.settings.saving')}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </DialogContent>
  </Dialog>;
}
