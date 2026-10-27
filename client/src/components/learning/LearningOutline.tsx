import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, FileText, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import type { LearningNode } from './learning-model.js';
import { masterySummary } from './learning-model.js';
import { MasteryBadge } from './MasteryDisplay.js';
export function LearningOutline({ nodes, onOpen, onEditGroup }: { nodes: LearningNode[]; onOpen: (id: string) => void; onEditGroup: (node: LearningNode) => void }) {
  const { t } = useTranslation('learning');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  function branch(parent: string | null, depth = 0): ReactNode {
    return nodes.filter(n => n.parentId === parent).map(n => n.kind === 'item' ?
      <Button key={n.id} variant="row" size="bare" className="flex min-h-13 w-full justify-start gap-2 rounded-md px-3 py-2 text-left" onClick={() => onOpen(n.id)}>
        <FileText className="size-4 shrink-0" aria-hidden="true" /><span className="min-w-0 flex-1 break-words whitespace-normal">{n.title}</span><MasteryBadge status={n.status}/><ChevronRight className="size-4 shrink-0" aria-hidden="true" />
      </Button> :
      <section key={n.id} className="border-b last:border-b-0" style={depth ? { marginLeft: Math.min(depth, 3) * 8 } : undefined}>
        <div className="flex items-center"><Button variant="row" size="bare" className="flex min-h-13 min-w-0 flex-1 justify-start gap-2 px-2 py-2 text-left" aria-expanded={!collapsed[n.id]} aria-controls={'learning-outline-' + n.id}
          onClick={() => setCollapsed(s => ({ ...s, [n.id]: !s[n.id] }))}>
          {collapsed[n.id] ? <ChevronRight className="size-4 shrink-0" /> : <ChevronDown className="size-4 shrink-0" />}<span className="min-w-0 flex-1 break-words whitespace-normal">{n.title}</span>
          <small className="shrink-0 text-muted-foreground">{t('progress', masterySummary(nodes,n.id))}</small>
        </Button><Button variant="ghost" size="icon" className="size-11 shrink-0" aria-label={t('editGroupNamed', { title: n.title })} onClick={() => onEditGroup(n)}><Pencil className="size-4" /></Button></div>
        <div id={'learning-outline-' + n.id} hidden={collapsed[n.id]}>{branch(n.id, depth + 1)}</div>
      </section>);
  }
  return <div aria-label={t('outline')}>{branch(null)}</div>;
}
