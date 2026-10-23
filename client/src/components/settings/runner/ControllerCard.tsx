import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible.js';
import { settingsHash } from '@/components/settings/settings-categories.js';
import { CliCommands } from '@/components/settings/CliCommands.js';
import { serverInfoQueryOptions, type ServerInfo } from '@/components/settings/ServerSettings.js';
import { useSettingsQuery } from '@/components/settings/ModelSettings.js';

export function ControllerCard({ origin }: { origin: string }) {
  const { t } = useTranslation('settings');
  const info = useQuery<ServerInfo>(serverInfoQueryOptions);
  const settings = useSettingsQuery();
  const server = info.data?.mode === 'server';
  return (
    <div className="glass-subtle rounded-xl p-4">
      <h4 className="font-medium">{t('computers.controller.title')}</h4>
      <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted-foreground">{t('computers.controller.address')}</dt>
          <dd className="mt-0.5 break-all">{origin || t('computers.card.unknown')}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('computers.controller.mode')}</dt>
          <dd className="mt-0.5">{info.data ? (server ? t('computers.controller.modeServer') : t('computers.controller.modeLocal')) : t('computers.card.unknown')}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('computers.controller.version')}</dt>
          <dd className="mt-0.5">{info.data?.version || t('computers.card.unknown')}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('computers.controller.model')}</dt>
          <dd className="mt-0.5">
            {settings.data?.model || t('computers.controller.modelMissing')}
            {' '}
            <a className="text-brand-link underline-offset-4 hover:underline" href={`#${settingsHash('model')}`}>{t('computers.controller.modelLink')}</a>
          </dd>
        </div>
      </dl>
      <Collapsible className="mt-4 border-t border-[var(--glass-divider)] pt-3">
        <CollapsibleTrigger type="button" className="group flex w-full items-center gap-2 text-left text-sm font-medium">
          <ChevronDown aria-hidden="true" className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
          {t('computers.controller.commands')}
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-3 space-y-3">
          <p className="text-[13px] leading-relaxed text-muted-foreground">{t('computers.controller.commandsNote')}</p>
          {server && <p className="text-[13px] leading-relaxed text-muted-foreground">{t('computers.controller.serverPaths')}</p>}
          <CliCommands embedded />
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
