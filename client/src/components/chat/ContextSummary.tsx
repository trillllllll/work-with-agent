import { useTranslation } from 'react-i18next';
import type { ChatContextV2, ChatContextV3 } from '../../../../server/src/agent/chat-context.js';
import { pageNames } from '@/lib/assistant-context.js';

const statuses = ['all', 'open', 'todo', 'doing', 'blocked', 'done'] as const;
const sections = ['brief', 'memory', 'memories', 'suggestions', 'help', 'conversation', 'materials'] as const;
const layouts = ['day', 'week', 'month', 'list', 'board', 'quadrant'] as const;

export function ContextSummary({ context }: { context?: ChatContextV2 | ChatContextV3 | null }) {
  const { t } = useTranslation('chat');
  if (!context) return <span className="text-xs text-muted-foreground">{t('contextSummary.missing')}</span>;
  const statusName = (status: string) => (statuses as readonly string[]).includes(status) ? t(`contextSummary.status.${status}`) : '';
  const sectionName = (section: string) => (sections as readonly string[]).includes(section) ? t(`contextSummary.section.${section}`) : section;
  const layoutName = (layout: string) => (layouts as readonly string[]).includes(layout) ? t(`contextSummary.layout.${layout}`) : layout;
  return <details className="text-xs text-muted-foreground" data-testid="context-summary">
    <summary className="cursor-pointer py-1">{context.schemaVersion === 3 ? context.label : pageNames[context.page] ?? context.page}</summary>
    <div className="space-y-1 break-words py-2">
      <p>{context.scope.kind === 'all' ? t('contextSummary.scopeAll') : context.scope.kind === 'inbox' ? t('contextSummary.scopeInbox') : t('contextSummary.scopeList')}</p>
      {context.taskId && <p>{t('contextSummary.currentTask')}</p>}
      {context.materialId && <p>{context.schemaVersion === 3 && context.materialRevision ? t('contextSummary.materialRevision', { revision: context.materialRevision }) : t('contextSummary.material')}</p>}
      {context.selectedTaskIds.length > 0 && <p>{t('contextSummary.selectedTasks', { count: context.selectedTaskIds.length })}</p>}
      {context.taskFilter && <>
        {context.taskFilter.q && <p>{t('contextSummary.search', { query: context.taskFilter.q })}</p>}
        {context.taskFilter.status && <p>{statusName(context.taskFilter.status) ? t('contextSummary.statusLine', { status: statusName(context.taskFilter.status) }) : t('contextSummary.statusOnly')}</p>}
        {(context.taskFilter.dueFrom || context.taskFilter.dueTo) && <p>{t('contextSummary.dueRange', { from: context.taskFilter.dueFrom || t('contextSummary.unlimited'), to: context.taskFilter.dueTo || t('contextSummary.unlimited') })}</p>}
        {(context.taskFilter.scheduledFrom || context.taskFilter.scheduledTo) && <p>{t('contextSummary.scheduledRange', { from: context.taskFilter.scheduledFrom || t('contextSummary.unlimited'), to: context.taskFilter.scheduledTo || t('contextSummary.unlimited') })}</p>}
        {context.taskFilter.tagIds?.length ? <p>{t('contextSummary.filteredTags', { count: context.taskFilter.tagIds.length })}</p> : null}
        {context.taskFilter.includeArchived && <p>{t('contextSummary.includeArchived')}</p>}
      </>}
      {context.schemaVersion === 3 && <>
        {context.section && <p>{t('contextSummary.sectionLine', { section: sectionName(context.section) })}</p>}
        {context.pageState.selectedRevision && <p>{t('contextSummary.viewingRevision', { revision: context.pageState.selectedRevision })}</p>}
        {context.pageState.query && <p>{t('contextSummary.search', { query: context.pageState.query })}</p>}
        {context.pageState.folderId && <p>{t('contextSummary.folderScope')}</p>}
        {context.selectedMaterialIds.length > 0 && <p>{t('contextSummary.selectedMaterials', { count: context.selectedMaterialIds.length })}</p>}
        {context.pageState.layout && <p>{t('contextSummary.layoutLine', { layout: layoutName(context.pageState.layout) })}</p>}
        {context.attachments.map((item) => <details key={item.id}><summary>{t(item.unsaved ? 'contextSummary.unsavedAttachment' : 'contextSummary.selectedAttachment', { title: item.title })}</summary><pre className="max-h-40 overflow-auto whitespace-pre-wrap">{item.text}</pre></details>)}
      </>}
    </div>
  </details>;
}
