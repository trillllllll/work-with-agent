import { useState } from 'react';
import { ChevronDown, ListChecks, SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog.js';
import { Button } from '@/components/ui/button.js';
import { ChoiceList } from '@/components/ui/choice-list.js';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog.js';
import { Input } from '@/components/ui/input.js';
import type { HarnessKind, HarnessSettingsChange, HarnessSettingsView } from '../../../../server/src/node-agent/harness-protocol.js';

export function HarnessSettings({ settings, harness, disabled, saving, error, onChange, onForkProvider }: {
  settings: HarnessSettingsView;
  harness?: HarnessKind;
  disabled: boolean;
  saving: boolean;
  error: string | null;
  onChange: (changes: HarnessSettingsChange) => void;
  onForkProvider?: (provider: string) => void;
}) {
  const { t } = useTranslation('workspace');
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState('');
  const [confirmFullAccess, setConfirmFullAccess] = useState(false);
  const selected = settings.models.find((model) => model.id === settings.model);
  const modelName = selected?.label ?? settings.model;
  const models = selected ? settings.models : [{ id: settings.model, label: modelName }, ...settings.models];
  const search = query.trim().toLocaleLowerCase();
  const filtered = models.filter((model) => (model.label + ' ' + model.id).toLocaleLowerCase().includes(search));
  const effortName = (id: string) => t('harness.settings.efforts.' + id, { defaultValue: id });
  const zcode = harness === 'zcode';
  const claude = harness === 'claude';
  const permissionModes = settings.permissionModes;
  const sandboxChoices = settings.sandboxChoices ?? (['readOnly', 'workspace'] as const);
  const readOnly = settings.permission === 'readOnly' || settings.mode === 'plan';
  const mode = claude && readOnly ? 'plan' : settings.mode;
  const showWorkMode = (!claude || !permissionModes) && (settings.planAvailable || mode === 'plan');

  return <><Dialog onOpenChange={(open) => { if (!open) { setQuery(''); setProvider(''); setConfirmFullAccess(false); } }}>
    <DialogTrigger asChild>
      <Button type="button" variant="ghost" size="sm"
        className="min-h-11 max-w-[40vw] shrink-0 justify-start gap-1.5 px-2 sm:max-w-56"
        aria-label={t('harness.settings.title')} title={modelName} disabled={disabled}>
        {mode === 'plan' ? <ListChecks aria-hidden="true" className="size-3.5" /> : <SlidersHorizontal aria-hidden="true" className="size-3.5" />}
        <span className="min-w-0 truncate">{modelName}</span>
        <ChevronDown aria-hidden="true" className="size-3" />
      </Button>
    </DialogTrigger>
    <DialogContent className="flex max-h-[85dvh] flex-col overflow-hidden">
      <DialogHeader>
        <DialogTitle>{t('harness.settings.title')}</DialogTitle>
        <DialogDescription>{t(zcode ? 'harness.settings.zcodeLive' : 'harness.settings.nextTurn')}</DialogDescription>
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
        {!zcode && selected?.efforts.length ? <ChoiceList label={t('harness.settings.effort')} value={settings.effort ?? ''}
          options={selected.efforts.map((id) => ({ id, label: effortName(id) }))}
          onChange={(effort) => onChange({ effort })} disabled={disabled} /> : null}
        {showWorkMode && <ChoiceList label={t('harness.settings.mode')} value={mode}
          options={[
            { id: 'default', label: t('harness.settings.defaultMode') },
            ...(settings.planAvailable || mode === 'plan' ? [{ id: 'plan', label: t('harness.settings.planMode'),
              description: t(zcode ? 'harness.settings.zcodePlan' : 'harness.settings.planHint') }] : []),
          ]}
          onChange={(id) => onChange({ mode: id === 'plan' ? 'plan' : 'default',
            ...(claude && id === 'default' && settings.permission === 'readOnly' ? { permission: 'workspace' } : {}) })} disabled={disabled} />}
        {permissionModes?.length ? <div className="space-y-1.5">
          <ChoiceList label={t('harness.settings.permissionMode')} value={settings.permissionMode ?? ''}
            options={permissionModes.map((id) => ({ id, label: t('harness.settings.nativeModes.' + id + '.label'),
              description: t('harness.settings.nativeModes.' + id + '.description') }))}
            disabled={disabled || zcode && mode === 'plan'} onChange={(id) => {
              const permissionMode = permissionModes.find((value) => value === id);
              if (permissionMode === 'yolo') setConfirmFullAccess(true);
              else if (permissionMode) onChange({ permissionMode });
            }} />
          {zcode && mode === 'plan' && <p className="text-xs text-muted-foreground">{t('harness.settings.modeAfterPlan')}</p>}
        </div> : null}
        {!zcode && !claude && sandboxChoices.length > 0 && <ChoiceList
          label={t(settings.sandboxChoices ? 'harness.settings.sandbox' : 'harness.settings.permission')} value={settings.permission}
          options={sandboxChoices.map((id) => id === 'readOnly' ? { id, label: t('harness.settings.readOnly') }
            : { id, label: t('harness.settings.workspace'), description: t(settings.sandboxChoices ? 'harness.settings.sandboxWorkspaceHint' : 'harness.settings.workspaceHint') })}
          onChange={(permission) => onChange({ permission: permission === 'readOnly' ? 'readOnly' : 'workspace' })} disabled={disabled} />}
        {settings.approvalPolicies?.length ? <div className="space-y-1.5">
          <ChoiceList label={t('harness.settings.approvalPolicy')} value={readOnly ? 'never' : settings.approvalPolicy ?? 'on-request'}
            options={settings.approvalPolicies.map((id) => ({ id, label: t('harness.settings.approvalPolicies.' + id + '.label'),
              description: t('harness.settings.approvalPolicies.' + id + '.description') }))}
            disabled={disabled || readOnly} onChange={(id) => {
              const approvalPolicy = settings.approvalPolicies?.find((value) => value === id);
              if (approvalPolicy) onChange({ approvalPolicy });
            }} />
          {readOnly && <p className="text-xs text-muted-foreground">{t('harness.settings.readOnlyApprovals')}</p>}
        </div> : null}
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
  </Dialog>
    {confirmFullAccess && <ConfirmDialog title={t('harness.settings.fullAccessTitle')}
      description={t('harness.settings.fullAccessDescription')} confirmLabel={t('harness.settings.fullAccessConfirm')}
      onCancel={() => setConfirmFullAccess(false)} onConfirm={() => {
        setConfirmFullAccess(false);
        if (!disabled && settings.mode !== 'plan' && settings.permissionModes?.includes('yolo')) onChange({ permissionMode: 'yolo' });
      }} />}
  </>;
}
