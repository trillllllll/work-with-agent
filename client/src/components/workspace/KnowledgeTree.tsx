import type { ReactNode } from 'react';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api.js';
import { MemorySummary, type MemoryCardData } from './memory-view.js';

type Branch = { id: string; label: string; count: number; children?: Branch[] };
type Entry = MemoryCardData & { type: string; branchIds: string[] };

export function KnowledgeTree({ topicId, brief }: { topicId: string | null; brief: ReactNode }) {
  const query = useQuery({ queryKey: ['knowledge-tree', topicId], queryFn: () => api<{ branches: Branch[]; entries: Entry[] }>(`/api/v1/knowledge/tree?topicId=${encodeURIComponent(topicId || 'inbox')}`) });
  const [selected, setSelected] = useState('memories');
  const [open, setOpen] = useState<string[]>([]);
  const branches = query.data?.branches ?? [];
  const entries = (query.data?.entries ?? []).filter((entry) => entry.branchIds.includes(selected));
  const toggle = (id: string) => setOpen((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  return <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
    <nav aria-label="知识树" className="glass-subtle max-h-[70vh] space-y-1 overflow-y-auto rounded-xl p-3">
      {query.error && <p role="alert" className="text-sm text-destructive">{query.error.message}</p>}
      {branches.map((branch) => <div key={branch.id}>
        <button type="button" className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-muted" aria-pressed={selected === branch.id} onClick={() => { setSelected(branch.id); if (branch.children?.length) toggle(branch.id); }}>
          <span>{open.includes(branch.id) || selected.startsWith(branch.id) ? '▾' : '▸'} {branch.label}</span><span className="text-xs text-muted-foreground">{branch.count}</span>
        </button>
        {(open.includes(branch.id) || branch.children?.some((child) => child.id === selected)) && branch.children?.map((child) => <button key={child.id} type="button" className="flex w-full items-center justify-between gap-2 rounded-lg py-1.5 pr-2 pl-7 text-left text-sm hover:bg-muted" aria-pressed={selected === child.id} onClick={() => setSelected(child.id)}><span>{child.label}</span><span className="text-xs text-muted-foreground">{child.count}</span></button>)}
      </div>)}
    </nav>
    <div className="min-w-0 space-y-3">
      {selected === 'brief' ? brief : <>
        {!query.isLoading && !entries.length && <p className="py-6 text-sm text-muted-foreground">这一支还没有内容。</p>}
        {entries.map((entry) => <article key={`${entry.type}:${entry.id}`} className="glass-subtle rounded-xl p-4">{entry.type === 'memory' ? <MemorySummary memory={entry} /> : <div><strong className="text-sm">{entry.title}</strong>{entry.excerpt && <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">{entry.excerpt}</p>}<p className="mt-2 text-xs text-muted-foreground">{entry.type === 'material' ? '会话' : '产物'}</p></div>}</article>)}
      </>}
    </div>
  </div>;
}
