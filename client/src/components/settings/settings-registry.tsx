import type { ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Database, Info, MonitorSmartphone, Sparkles, SquareTerminal, Zap, type LucideIcon } from 'lucide-react';
import { api, type Settings, type View } from '@/lib/api.js';
import { MOBILE_NAVIGATION_LABELS, type MobileNavigationSettings as MobileNavigationPayload } from '@/lib/mobile-navigation.js';
import { mobileNavigationKey } from '@/hooks/useMobileNavigation.js';
import { currentLanguage, intlLocale } from '@/i18n/index.js';
import { OrchestrationSettings } from '@/components/orchestration/OrchestrationSettings.js';
import type { SettingsCategory, SettingsSectionId } from './settings-categories.js';
import { ModelSettings, useSettingsQuery } from './ModelSettings.js';
import { ImageSearchSettings } from './ImageSearchSettings.js';
import { HtmlBlockSettings } from './HtmlBlockSettings.js';
import { CliCommands } from './CliCommands.js';
import { WorktreesEntry } from './WorktreesEntry.js';
import { SkillsSummary, skillCounts, skillsQueryOptions } from './SkillsSummary.js';
import { LanguageSettings } from './LanguageSettings.js';
import { MobileNavigationSettings } from './MobileNavigationSettings.js';
import { BackupSettings, snapshotsQueryOptions } from './BackupSettings.js';
import { ServerSettings, serverInfoQueryOptions } from './ServerSettings.js';

export type SettingsSectionProps = { onNavigate: (view: View) => void };

/** Section id → component. Add a row here together with the id in `settings-categories.ts`. */
export const SETTINGS_SECTION_COMPONENTS: Record<SettingsSectionId, ComponentType<SettingsSectionProps>> = {
  model: ModelSettings,
  'image-search': ImageSearchSettings,
  'html-blocks': HtmlBlockSettings,
  cli: CliCommands,
  orchestration: OrchestrationSettings,
  worktrees: ({ onNavigate }) => <WorktreesEntry onOpenWorktrees={() => onNavigate('worktrees')} />,
  skills: ({ onNavigate }) => <SkillsSummary onOpenSkills={() => onNavigate('skills')} />,
  language: LanguageSettings,
  'mobile-navigation': MobileNavigationSettings,
  backup: BackupSettings,
  server: ServerSettings,
};

export const SETTINGS_CATEGORY_ICONS: Record<SettingsCategory, LucideIcon> = {
  model: Sparkles,
  local: SquareTerminal,
  skills: Zap,
  ui: MonitorSmartphone,
  data: Database,
  about: Info,
};

type ImageSearchState = { configured: boolean };
type NodeRow = { status: string; online: boolean };

/** One-line status shown under each category name. Reuses the query keys of the sections themselves. */
export function useSettingsCategoryHints(): Record<SettingsCategory, string> {
  const { t } = useTranslation('settings');
  const settings = useSettingsQuery();
  const imageSearch = useQuery({ queryKey: ['image-search-settings'], queryFn: () => api<ImageSearchState>('/api/settings/image-search') });
  const nodes = useQuery({ queryKey: ['nodes'], queryFn: () => api<NodeRow[]>('/api/nodes') });
  const skills = useQuery(skillsQueryOptions);
  const navigation = useQuery<MobileNavigationPayload>({ queryKey: mobileNavigationKey, queryFn: ({ signal }) => api<MobileNavigationPayload>('/api/settings/mobile-navigation', { signal }) });
  const snapshots = useQuery(snapshotsQueryOptions);
  const server = useQuery(serverInfoQueryOptions);
  const sep = t('layout.hints.separator');
  const loading = t('layout.hints.loading');
  const join = (parts: Array<string | null | undefined | false>) => parts.filter(Boolean).join(sep) || loading;

  const data: Settings | undefined = settings.data;
  const configured = Boolean(data?.model && data?.baseUrl && data?.apiKeyConfigured);
  const source = (item?: { source?: string }) => item?.source === 'manual' ? t('cli.sourceManual') : item?.source === 'auto' ? t('cli.sourceAuto') : t('cli.sourceNone');
  const online = (nodes.data ?? []).filter((node) => node.status === 'active' && node.online).length;
  const latest = (snapshots.data ?? []).map((item) => item.createdAt).sort().pop();
  const time = latest ? new Intl.DateTimeFormat(intlLocale(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(latest)) : null;

  return {
    model: join([
      data ? (configured ? data.model : t('layout.hints.noModel')) : null,
      imageSearch.data ? (imageSearch.data.configured ? t('layout.hints.imageSearchOn') : t('layout.hints.imageSearchOff')) : null,
    ]),
    local: join([
      data ? t('layout.hints.cli', { codex: source(data.cli?.codex), claude: source(data.cli?.claude) }) : null,
      online > 0 && t('layout.hints.nodesOnline', { count: online }),
    ]),
    skills: skills.data ? t('layout.hints.skills', skillCounts(skills.data)) : loading,
    ui: join([
      t(`language.options.${currentLanguage()}`),
      navigation.data && t('layout.hints.bar', { items: navigation.data.visibleViews.map((view) => MOBILE_NAVIGATION_LABELS[view]).filter(Boolean).join(t('layout.hints.listSeparator')) }),
    ]),
    data: snapshots.data ? (time ? t('layout.hints.latestSnapshot', { time }) : t('layout.hints.noSnapshot')) : loading,
    about: join([
      server.data && (server.data.mode === 'server' ? t('server.serverValue') : t('server.localValue')),
      server.data?.version,
    ]),
  };
}
