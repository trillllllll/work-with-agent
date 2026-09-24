import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { json, submitCommands, usePlatformAction } from '@/lib/platform.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Textarea } from '@/components/ui/textarea.js';
import { BLOB_PAD, communityColors, communityOutline, communityRadius, fittedScale, layoutClusterCenters, memberRing, projectGround } from './graph-layout.js';
import { entityKindNames, relationNames } from './memory-view.js';

type GraphNode = { id: string; rawId: string; type: 'memory' | 'material' | 'task' | 'artifact' | 'entity'; title: string; kind?: string; status?: string; excerpt?: string; description?: string; importance?: number; labels?: string[]; origin?: string; revision?: number; memoryCount?: number; createdAt?: string };
type GraphEdge = { id: string; from: string; to: string; relation: string; manual: boolean };
type GraphData = { nodes: GraphNode[]; edges: GraphEdge[]; focusIds: string[]; truncated: boolean; mode: string; range: number };
const colors: Record<string, string> = { entity: 'hsl(262 28% 64%)', memory: 'hsl(206 22% 64%)', material: 'hsl(150 16% 56%)', thread: 'hsl(28 22% 60%)', task: 'hsl(40 20% 60%)', artifact: 'hsl(345 16% 62%)', crystal: 'hsl(262 14% 74%)' };
const colorOf = (node: GraphNode) => node.type === 'memory' && node.kind === 'crystal' ? colors.crystal : node.type === 'material' && node.kind === 'thread' ? colors.thread : colors[node.type] ?? '#94a3b8';
const typeNames: Record<string, string> = { memory: '记忆', material: '资料', task: '任务', artifact: '产物', entity: '实体' };

export function KnowledgeGraph({ topicId }: { topicId: string | null }) {
  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  const [mode, setMode] = useState<'fast' | 'smart'>('smart');
  const [range, setRange] = useState(1);
  const [focus, setFocus] = useState<{ type: GraphNode['type']; id: string } | null>(null);
  const [history, setHistory] = useState(false);
  const [spatial, setSpatial] = useState<'2d' | '3d'>('2d');
  const [panel, setPanel] = useState<'read' | 'open' | 'ontology' | 'maintain'>('read');
  const [selectedId, setSelectedId] = useState('');
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<{ mode: string; answer: string | null; notice?: string; citations: GraphNode[] } | null>(null);
  const [asking, setAsking] = useState(false);
  const scope = `topicId=${encodeURIComponent(topicId || 'inbox')}`;
  const query = useQuery({ queryKey: ['knowledge-graph', topicId, q, mode, range, focus, history], queryFn: () => api<GraphData>(`/api/v1/knowledge/graph?${scope}&q=${encodeURIComponent(q)}&mode=${mode}&range=${range}&includeHistory=${history}${focus ? `&focusType=${focus.type}&focusId=${encodeURIComponent(focus.id)}` : ''}`) });
  const nodes = query.data?.nodes ?? [];
  const edges = query.data?.edges ?? [];
  const selected = nodes.find((node) => node.id === selectedId) ?? null;
  const detailPath = selected?.type === 'memory' ? `/api/v1/knowledge/memories/${selected.rawId}` : selected?.type === 'material' ? `/api/v1/knowledge/materials/${selected.rawId}` : '';
  const detail = useQuery({ queryKey: ['graph-detail', detailPath], queryFn: () => api<any>(detailPath), enabled: Boolean(detailPath) });
  const { run, busy } = usePlatformAction();
  const neighbors = selected ? edges.filter((edge) => edge.from === selected.id || edge.to === selected.id).map((edge) => ({ edge, node: nodes.find((node) => node.id === (edge.from === selected.id ? edge.to : edge.from)) })).filter((item) => item.node) : [];
  async function ask() {
    if (!question.trim()) return;
    setAsking(true);
    try { setAnswer(await api('/api/v1/knowledge/graph/ask', { method: 'POST', body: json({ topicId, question, mode, range }) })); }
    catch (error) { toast.error(error instanceof Error ? error.message : '提问失败'); }
    finally { setAsking(false); }
  }
  return <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input aria-label="搜索图谱" placeholder="搜索实体、主题或问题" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { setQ(draft.trim()); setFocus(null); } }} className="max-w-sm" />
        <Button size="sm" variant={mode === 'smart' ? 'secondary' : 'ghost'} onClick={() => setMode('smart')}>智能</Button>
        <Button size="sm" variant={mode === 'fast' ? 'secondary' : 'ghost'} onClick={() => setMode('fast')}>快速</Button>
        <div className="flex items-center gap-1" role="group" aria-label="关系跳数">{[1, 2, 3, 4, 5].map((value) => <Button key={value} size="sm" variant={range === value ? 'secondary' : 'ghost'} aria-pressed={range === value} onClick={() => setRange(value)}>{value}</Button>)}</div>
        <Button size="sm" variant={spatial === '2d' ? 'secondary' : 'ghost'} aria-pressed={spatial === '2d'} onClick={() => setSpatial('2d')}>2D</Button>
        <Button size="sm" variant={spatial === '3d' ? 'secondary' : 'ghost'} aria-pressed={spatial === '3d'} onClick={() => setSpatial('3d')}>3D</Button>
        <Button size="sm" variant="ghost" onClick={() => { setQ(''); setDraft(''); setFocus(null); setSelectedId(''); }}>看全图</Button>
      </div>
      {query.error && <p role="alert" className="text-sm text-destructive">{query.error.message}</p>}
      {query.data?.truncated && <p className="text-xs text-muted-foreground">节点较多，当前只显示前 500 个。</p>}
      <GraphCanvas nodes={nodes} edges={edges} selectedId={selectedId} spatial={spatial} onSelect={(node) => { setSelectedId(node.id); setFocus({ type: node.type, id: node.rawId }); }} />
      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">{Object.entries(typeNames).map(([type, label]) => <span key={type} className="inline-flex items-center gap-1"><i className="inline-block size-2 rounded-full" style={{ background: colors[type] }} />{label}</span>)}<span className="inline-flex items-center gap-1"><i className="inline-block size-2 rounded-full" style={{ background: colors.thread }} />对话</span><span className="inline-flex items-center gap-1"><i className="inline-block size-2 rounded-full" style={{ background: colors.crystal }} />结晶</span></div>
      <div aria-label="图中节点" className="flex max-h-28 flex-wrap gap-2 overflow-y-auto">{nodes.map((node) => <Button key={node.id} size="sm" variant={selectedId === node.id ? 'secondary' : 'ghost'} onClick={() => { setSelectedId(node.id); setFocus({ type: node.type, id: node.rawId }); }}>{node.title}</Button>)}{!nodes.length && <p className="text-sm text-muted-foreground">这张图里还没有节点。</p>}</div>
      <label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={history} onChange={(event) => setHistory(event.target.checked)} />包含历史记忆和归档材料</label>
    </div>
    <aside className="glass-subtle space-y-3 rounded-xl p-4">
      <div className="flex flex-wrap gap-1" role="tablist" aria-label="图谱侧栏">{[['read', '解读'], ['open', '查看'], ['ontology', '本体'], ['maintain', '图谱维护']].map(([id, label]) => <Button key={id} size="sm" variant={panel === id ? 'secondary' : 'ghost'} onClick={() => setPanel(id as typeof panel)}>{label}</Button>)}</div>
      {panel === 'read' && <div className="space-y-3 text-sm">{selected ? <><h2 className="font-semibold">{selected.title}</h2><p className="text-xs text-muted-foreground">{typeNames[selected.type]}{selected.kind ? ` · ${entityKindNames[selected.kind as keyof typeof entityKindNames] ?? selected.kind}` : ''}</p><p className="whitespace-pre-wrap text-muted-foreground">{selected.excerpt || selected.description || '没有更多摘要。'}</p><h3 className="text-xs font-semibold">一度邻居</h3><ul className="space-y-2">{neighbors.map(({ edge, node }) => <li key={edge.id}><button type="button" className="text-left" onClick={() => node && setSelectedId(node.id)}>{node?.title}</button><span className="ml-2 text-xs text-muted-foreground">{relationNames[edge.relation] ?? edge.relation}</span></li>)}{!neighbors.length && <li className="text-xs text-muted-foreground">没有直接相连的节点。</li>}</ul></> : <p className="text-muted-foreground">点一个节点，查看它和相邻记录。</p>}</div>}
      {panel === 'open' && <div className="space-y-2 text-sm">{!selected && <p className="text-muted-foreground">先在图里选择一条记录。</p>}{selected && <h2 className="font-semibold">{selected.title}</h2>}{detail.data?.content && <p className="whitespace-pre-wrap">{detail.data.content}</p>}{selected?.type === 'entity' && <p className="whitespace-pre-wrap">{selected.description || '这个实体还没有说明。'}</p>}{selected && !['memory', 'material', 'entity'].includes(selected.type) && <p className="whitespace-pre-wrap text-muted-foreground">{selected.excerpt}</p>}</div>}
      {panel === 'ontology' && <Ontology topicId={topicId} nodes={nodes.filter((node) => node.type === 'entity')} busy={busy} run={run} />}
      {panel === 'maintain' && <Maintain topicId={topicId} nodes={nodes} selected={selected} edges={neighbors} busy={busy} run={run} />}
      <form className="space-y-2 border-t pt-3" onSubmit={(event) => { event.preventDefault(); void ask(); }}>
        <Textarea aria-label="询问知识图谱" placeholder="问一下你的知识图谱" value={question} onChange={(event) => setQuestion(event.target.value)} rows={3} />
        <Button size="sm" disabled={asking || !question.trim()}>{asking ? '正在检索' : '提问'}</Button>
        {answer?.notice && <p className="text-xs text-muted-foreground">{answer.notice}</p>}
        {answer?.answer && <p className="whitespace-pre-wrap text-sm">{answer.answer}</p>}
        {answer?.mode === 'retrieval' && <ul className="space-y-2 text-sm">{answer.citations.map((node) => <li key={node.id}><strong>{node.title}</strong><p className="text-xs text-muted-foreground">{node.excerpt}</p></li>)}</ul>}
      </form>
    </aside>
  </div>;
}

function Ontology({ topicId, nodes, busy, run }: { topicId: string | null; nodes: GraphNode[]; busy: boolean; run: ReturnType<typeof usePlatformAction>['run'] }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('concept');
  return <div className="space-y-3 text-sm">
    <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void run(() => submitCommands([{ kind: 'entity.create', input: { topicId, name, kind } }]), '实体已建立').then(() => setName('')); }}>
      <Input aria-label="新实体名称" placeholder="新实体" value={name} onChange={(event) => setName(event.target.value)} required />
      <KindSelect value={kind} onChange={setKind} />
      <Button size="sm" disabled={busy || !name.trim()}>建立实体</Button>
    </form>
    <ul className="space-y-2">{nodes.map((node) => <li key={node.id} className="flex items-center justify-between gap-2"><span>{node.title}</span><span className="text-xs text-muted-foreground">{entityKindNames[node.kind as keyof typeof entityKindNames] ?? node.kind} · 记忆 {node.memoryCount ?? 0}</span></li>)}{!nodes.length && <li className="text-xs text-muted-foreground">还没有实体。保存带标签的记忆后会自动出现。</li>}</ul>
  </div>;
}

function Maintain({ topicId, nodes, selected, edges, busy, run }: { topicId: string | null; nodes: GraphNode[]; selected: GraphNode | null; edges: Array<{ edge: GraphEdge; node?: GraphNode }>; busy: boolean; run: ReturnType<typeof usePlatformAction>['run'] }) {
  const [name, setName] = useState(selected?.type === 'entity' ? selected.title : '');
  const [kind, setKind] = useState(selected?.kind ?? 'concept');
  const [description, setDescription] = useState(selected?.description ?? '');
  const [target, setTarget] = useState('');
  const [relation, setRelation] = useState('related');
  useEffect(() => { setName(selected?.type === 'entity' ? selected.title : ''); setKind(selected?.kind && selected.kind in entityKindNames ? selected.kind : 'concept'); setDescription(selected?.description ?? ''); }, [selected?.id, selected?.title, selected?.kind, selected?.description, selected?.type]);
  if (selected?.type !== 'entity') return <p className="text-sm text-muted-foreground">选择一个实体后，可以改名、连接其他节点，或在它有至少三条记忆时沉淀结晶。</p>;
  return <form className="space-y-2 text-sm" onSubmit={(event) => { event.preventDefault(); void run(() => submitCommands([{ kind: 'entity.update', targetId: selected.rawId, expectedRevision: selected.revision, input: { name, kind, description } }]), '实体已更新'); }}>
    <Input aria-label="实体名称" value={name} onChange={(event) => setName(event.target.value)} required />
    <KindSelect value={kind} onChange={setKind} />
    <Textarea aria-label="实体说明" value={description} onChange={(event) => setDescription(event.target.value)} rows={3} />
    <div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy || !name.trim()}>保存实体</Button><Button type="button" size="sm" variant="ghost" disabled={busy || (selected.memoryCount ?? 0) > 0} onClick={() => void run(() => submitCommands([{ kind: 'entity.delete', targetId: selected.rawId, expectedRevision: selected.revision, input: {} }]), '实体已删除')}>删除实体</Button><Button type="button" size="sm" variant="outline" disabled={busy || (selected.memoryCount ?? 0) < 3} onClick={() => void run(() => submitCommands([{ kind: 'memory.crystallize', input: { topicId, entityId: selected.rawId } }]), '结晶记忆已保存')}>沉淀结晶</Button></div>
    <p className="text-xs text-muted-foreground">当前有 {selected.memoryCount ?? 0} 条相连记忆。结晶需要至少三条。</p>
    <div className="space-y-2 border-t pt-3">
      <select aria-label="连接到" className="glass-control h-9 w-full rounded-lg px-3 text-sm" value={target} onChange={(event) => setTarget(event.target.value)}><option value="">选择另一个节点</option>{nodes.filter((node) => node.id !== selected.id).map((node) => <option key={node.id} value={`${node.type}:${node.rawId}`}>{typeNames[node.type]} · {node.title}</option>)}</select>
      <select aria-label="关系类型" className="glass-control h-9 w-full rounded-lg px-3 text-sm" value={relation} onChange={(event) => setRelation(event.target.value)}><option value="related">相关</option><option value="about">关于</option><option value="contrasts">冲突</option></select>
      <Button type="button" size="sm" variant="outline" disabled={busy || !target} onClick={() => { const [toType, ...rest] = target.split(':'); void run(() => submitCommands([{ kind: 'graph.link', input: { topicId, fromType: 'entity', fromId: selected.rawId, toType, toId: rest.join(':'), relation } }]), '关系已建立'); }}>建立关系</Button>
      <ul className="space-y-1">{edges.filter(({ edge }) => edge.manual).map(({ edge, node }) => <li key={edge.id} className="flex items-center justify-between gap-2"><span>{relationNames[edge.relation]} · {node?.title}</span><Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => submitCommands([{ kind: 'graph.unlink', targetId: edge.id, input: {} }]), '关系已移除')}>移除</Button></li>)}</ul>
    </div>
  </form>;
}

function KindSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <select aria-label="实体类别" className="glass-control h-9 w-full rounded-lg px-3 text-sm" value={value} onChange={(event) => onChange(event.target.value)}>{Object.entries(entityKindNames).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>;
}

type Point = GraphNode & { x: number; y: number; h: number; vx: number; vy: number; cluster: string; homeX: number; homeY: number };
const otherCluster = 'other';

function clusterGroups(nodes: GraphNode[], edges: GraphEdge[]) {
  const membership = new Map<string, string>();
  const entities = nodes.filter((node) => node.type === 'entity');
  const entityIds = new Set(entities.map((node) => node.id));
  const titles = new Map(entities.map((node) => [node.id, node.title]));
  for (const entity of entities) membership.set(entity.id, entity.id);
  const neighbors = new Map<string, string[]>();
  for (const edge of edges) {
    neighbors.set(edge.from, [...(neighbors.get(edge.from) ?? []), edge.to]);
    neighbors.set(edge.to, [...(neighbors.get(edge.to) ?? []), edge.from]);
  }
  const sizes = () => {
    const counts = new Map<string, number>();
    for (const id of membership.values()) counts.set(id, (counts.get(id) ?? 0) + 1);
    return counts;
  };
  const pick = (counts: Map<string, number>) => {
    const members = sizes();
    let best = '';
    let bestEdges = 0;
    let bestDegree = -1;
    let bestSize = -1;
    let bestName = '\uffff';
    for (const [id, count] of counts) {
      const degree = (neighbors.get(id) ?? []).length;
      const size = members.get(id) ?? 0;
      const name = titles.get(id) ?? '';
      const closer = count > bestEdges || (count === bestEdges && (degree > bestDegree || (degree === bestDegree && (size > bestSize || (size === bestSize && name.localeCompare(bestName, 'zh') < 0)))));
      if (closer) { best = id; bestEdges = count; bestDegree = degree; bestSize = size; bestName = name; }
    }
    return best;
  };
  for (const node of nodes) {
    if (entityIds.has(node.id)) continue;
    const counts = new Map<string, number>();
    for (const next of neighbors.get(node.id) ?? []) if (entityIds.has(next)) counts.set(next, (counts.get(next) ?? 0) + 1);
    const best = pick(counts);
    if (best) membership.set(node.id, best);
  }
  for (let round = 0; round < 6; round += 1) {
    let changed = false;
    for (const node of nodes) {
      if (membership.has(node.id)) continue;
      const counts = new Map<string, number>();
      for (const next of neighbors.get(node.id) ?? []) {
        const cluster = membership.get(next);
        if (cluster) counts.set(cluster, (counts.get(cluster) ?? 0) + 1);
      }
      const best = pick(counts);
      if (best) { membership.set(node.id, best); changed = true; }
    }
    if (!changed) break;
  }
  for (const node of nodes) if (!membership.has(node.id)) membership.set(node.id, otherCluster);
  for (const entity of entities) {
    if ([...membership.values()].filter((id) => id === entity.id).length > 1) continue;
    const counts = new Map<string, number>();
    for (const next of neighbors.get(entity.id) ?? []) {
      const cluster = membership.get(next);
      if (cluster && cluster !== entity.id) counts.set(cluster, (counts.get(cluster) ?? 0) + 1);
    }
    const best = pick(counts);
    if (best) membership.set(entity.id, best);
  }
  const labels = [...sizes().entries()].flatMap(([id, count]) => id === otherCluster && count < 2 ? [] : [{ id, name: titles.get(id) ?? '其他' }]);
  return { membership, labels };
}

function traceBlob(context: CanvasRenderingContext2D, points: Array<{ x: number; y: number }>) {
  if (points.length < 3) return;
  const middle = (left: { x: number; y: number }, right: { x: number; y: number }) => ({ x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 });
  const start = middle(points[points.length - 1], points[0]);
  context.beginPath();
  context.moveTo(start.x, start.y);
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = middle(current, points[(index + 1) % points.length]);
    context.quadraticCurveTo(current.x, current.y, next.x, next.y);
  }
  context.closePath();
}

type Relief = 'influence' | 'structure' | 'form' | 'growth';
type Surface = 'terrain' | 'star';
const reliefCopy: Record<Relief, string> = {
  influence: '影响力地形。高处代表更重要、连接更强的知识。',
  structure: '结构地形。高处离连接最多的节点更近，孤立的点贴在地面。',
  form: '形态地形。同一类节点抬成一层：记忆、实体、材料、任务、产物各占一条脊。',
  growth: '增长地形。高处代表最近更新的知识。',
};
const formHeight: Record<GraphNode['type'], number> = { memory: 1, entity: 0.78, material: 0.56, task: 0.34, artifact: 0.16 };

function nodeScores(items: Point[], edges: GraphEdge[], relief: Relief) {
  const degree = new Map<string, number>();
  for (const edge of edges) { degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1); degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1); }
  const hub = items.reduce((best, node) => (degree.get(node.id) ?? 0) > (degree.get(best.id) ?? 0) ? node : best, items[0]);
  const raw = new Map<string, number>();
  let low = Number.POSITIVE_INFINITY; let high = Number.NEGATIVE_INFINITY;
  for (const node of items) {
    const links = degree.get(node.id) ?? 0;
    const updated = Date.parse(node.createdAt ?? '');
    const value = relief === 'influence'
      ? (node.type === 'memory' ? (node.importance ?? 3) : node.type === 'entity' ? (node.memoryCount ?? links) : 1) + links
      : relief === 'structure'
        ? 1 / (1 + Math.hypot(node.x - hub.x, node.y - hub.y) / 90)
        : relief === 'form'
          ? formHeight[node.type]
          : Number.isFinite(updated) ? updated : 0;
    raw.set(node.id, value); low = Math.min(low, value); high = Math.max(high, value);
  }
  const span = high - low;
  return new Map([...raw].map(([id, value]) => [id, span ? (value - low) / span : 0.7]));
}

function terrainField(items: Point[], scores: Map<string, number>) {
  const cols = 46; const rows = 32;
  const bumps = new Map<string, { x: number; y: number; score: number; count: number }>();
  for (const node of items) {
    const bump = bumps.get(node.cluster) ?? { x: 0, y: 0, score: 0, count: 0 };
    bump.x += node.x; bump.y += node.y; bump.count += 1; bump.score = Math.max(bump.score, scores.get(node.id) ?? 0);
    bumps.set(node.cluster, bump);
  }
  const counts = new Map<string, number>();
  for (const node of items) counts.set(node.cluster, (counts.get(node.cluster) ?? 0) + 1);
  const hills = [...bumps.entries()].map(([id, bump]) => ({ x: bump.x / bump.count, y: bump.y / bump.count, score: bump.score, sigma: Math.max(32, communityRadius(counts.get(id) ?? bump.count) * 0.5) }));
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
  for (const node of items) { minX = Math.min(minX, node.x); maxX = Math.max(maxX, node.x); minY = Math.min(minY, node.y); maxY = Math.max(maxY, node.y); }
  const padX = Math.max(80, (maxX - minX) * 0.35); const padY = Math.max(60, (maxY - minY) * 0.35);
  minX -= padX; maxX += padX; minY -= padY; maxY += padY;
  const spanX = maxX - minX || 1; const spanY = maxY - minY || 1;
  const field = new Float32Array(cols * rows);
  let peak = 0;
  for (let row = 0; row < rows; row += 1) for (let col = 0; col < cols; col += 1) {
    const x = minX + (col / (cols - 1)) * spanX; const y = minY + (row / (rows - 1)) * spanY;
    let value = 0;
    for (const hill of hills) { const distance = (hill.x - x) ** 2 + (hill.y - y) ** 2; value = Math.max(value, hill.score * Math.exp(-distance / (2 * hill.sigma * hill.sigma))); }
    field[row * cols + col] = value; peak = Math.max(peak, value);
  }
  if (peak > 0) for (let index = 0; index < field.length; index += 1) field[index] /= peak;
  const sample = (x: number, y: number) => {
    const col = ((x - minX) / spanX) * (cols - 1); const row = ((y - minY) / spanY) * (rows - 1);
    const c0 = Math.max(0, Math.min(cols - 2, Math.floor(col))); const r0 = Math.max(0, Math.min(rows - 2, Math.floor(row)));
    const tx = col - c0; const ty = row - r0;
    const at = (c: number, r: number) => field[r * cols + c];
    return at(c0, r0) * (1 - tx) * (1 - ty) + at(c0 + 1, r0) * tx * (1 - ty) + at(c0, r0 + 1) * (1 - tx) * ty + at(c0 + 1, r0 + 1) * tx * ty;
  };
  return { field, cols, rows, minX, minY, spanX, spanY, sample };
}

function contourLines(field: Float32Array, cols: number, rows: number, level: number) {
  const lines: Array<[[number, number], [number, number]]> = [];
  const mix = (v1: number, v2: number, a: [number, number], b: [number, number]): [number, number] => {
    const t = (level - v1) / ((v2 - v1) || 1e-6);
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  };
  for (let row = 0; row < rows - 1; row += 1) for (let col = 0; col < cols - 1; col += 1) {
    const v00 = field[row * cols + col]; const v10 = field[row * cols + col + 1];
    const v11 = field[(row + 1) * cols + col + 1]; const v01 = field[(row + 1) * cols + col];
    let mask = 0;
    if (v00 >= level) mask |= 1; if (v10 >= level) mask |= 2; if (v11 >= level) mask |= 4; if (v01 >= level) mask |= 8;
    if (mask === 0 || mask === 15) continue;
    const top = mix(v00, v10, [col, row], [col + 1, row]);
    const right = mix(v10, v11, [col + 1, row], [col + 1, row + 1]);
    const bottom = mix(v01, v11, [col, row + 1], [col + 1, row + 1]);
    const left = mix(v00, v01, [col, row], [col, row + 1]);
    const pairs = mask === 1 || mask === 14 ? [[left, top]]
      : mask === 2 || mask === 13 ? [[top, right]]
        : mask === 3 || mask === 12 ? [[left, right]]
          : mask === 4 || mask === 11 ? [[right, bottom]]
            : mask === 6 || mask === 9 ? [[top, bottom]]
              : mask === 7 || mask === 8 ? [[bottom, left]]
                : mask === 5 ? [[left, bottom], [top, right]]
                  : [[top, left], [right, bottom]];
    lines.push(...pairs as Array<[[number, number], [number, number]]>);
  }
  return lines;
}

function GraphCanvas({ nodes, edges, selectedId, spatial, onSelect }: { nodes: GraphNode[]; edges: GraphEdge[]; selectedId: string; spatial: '2d' | '3d'; onSelect: (node: GraphNode) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const sim = useRef<Point[]>([]);
  const camera = useRef({ yaw: 0.42, pitch: 0.95, scale: 0.84, panX: 0, panY: 0 });
  const fitted = useRef(false);
  const drag = useRef<{ x: number; y: number; moved: boolean; id?: string } | null>(null);
  const [surface, setSurface] = useState<Surface>('terrain');
  const [relief, setRelief] = useState<Relief>('influence');
  const groups = useMemo(() => clusterGroups(nodes, edges), [nodes, edges]);
  useEffect(() => { fitted.current = false; }, [nodes, groups, spatial]);
  useEffect(() => {
    const ids = [...new Set(groups.membership.values())];
    const members = new Map<string, string[]>();
    for (const node of nodes) {
      const cluster = groups.membership.get(node.id) ?? otherCluster;
      members.set(cluster, [...(members.get(cluster) ?? []), node.id].sort());
    }
    const placed = layoutClusterCenters(ids.map((id) => ({ id, count: (members.get(id) ?? []).length })));
    sim.current = nodes.map((node) => {
      const cluster = groups.membership.get(node.id) ?? otherCluster;
      const group = members.get(cluster) ?? [node.id];
      const center = placed.get(cluster) ?? { x: 0, y: 0 };
      const index = Math.max(0, group.indexOf(node.id));
      const ring = memberRing(group.length);
      const angle = (index / Math.max(group.length, 1)) * Math.PI * 2 - Math.PI / 2;
      const x = center.x + Math.cos(angle) * ring;
      const y = center.y + Math.sin(angle) * ring;
      return { ...node, cluster, x, y, homeX: x, homeY: y, h: 0, vx: 0, vy: 0 };
    });
  }, [nodes, groups]);
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const context = canvas.getContext('2d'); if (!context) return;
    let frame = 0; let running = true;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const scene = spatial === '3d';
    const project = (x: number, y: number, lift: number, width: number, height: number) => projectGround(x, y, lift, camera.current, width, height, scene);
    const step = (animate: boolean) => {
      const items = sim.current; const byId = new Map(items.map((node) => [node.id, node]));
      if (animate) {
        for (let i = 0; i < items.length; i += 1) for (let j = i + 1; j < items.length; j += 1) {
          const left = items[i]; const right = items[j];
          if (left.cluster !== right.cluster) continue;
          const dx = left.x - right.x; const dy = left.y - right.y; const distance = Math.hypot(dx, dy) || 0.01;
          if (distance > 64) continue;
          const force = 420 / (distance * distance);
          left.vx += (dx / distance) * force; left.vy += (dy / distance) * force; right.vx -= (dx / distance) * force; right.vy -= (dy / distance) * force;
        }
        for (const node of items) {
          node.vx += (node.homeX - node.x) * 0.16; node.vy += (node.homeY - node.y) * 0.16;
          node.vx *= 0.55; node.vy *= 0.55; node.x += node.vx; node.y += node.vy;
        }
      }
      const ratio = window.devicePixelRatio || 1; const width = canvas.clientWidth; const height = canvas.clientHeight;
      canvas.width = Math.max(1, Math.floor(width * ratio)); canvas.height = Math.max(1, Math.floor(height * ratio)); context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      if (!fitted.current && width > 40 && height > 40 && items.length) {
        const ids = [...new Set(items.map((node) => node.cluster))];
        camera.current.scale = fittedScale(ids.map((id) => ({ id, count: items.filter((node) => node.cluster === id).length })), width, height, scene);
        fitted.current = true;
      }
      let ground: ReturnType<typeof terrainField> | null = null;
      if (scene && items.length && surface === 'terrain') {
        const scores = nodeScores(items, edges, relief);
        ground = terrainField(items, scores);
        for (const node of items) node.h = ground.sample(node.x, node.y);
        for (const level of [0.28, 0.42, 0.56, 0.7, 0.84]) {
          context.strokeStyle = `rgba(186, 210, 230, ${0.18 + level * 0.45})`; context.lineWidth = level > 0.7 ? 1.4 : 1;
          for (const [start, end] of contourLines(ground.field, ground.cols, ground.rows, level)) {
            const from = project(ground.minX + (start[0] / (ground.cols - 1)) * ground.spanX, ground.minY + (start[1] / (ground.rows - 1)) * ground.spanY, level, width, height);
            const to = project(ground.minX + (end[0] / (ground.cols - 1)) * ground.spanX, ground.minY + (end[1] / (ground.rows - 1)) * ground.spanY, level, width, height);
            context.beginPath(); context.moveTo(from.x, from.y); context.lineTo(to.x, to.y); context.stroke();
          }
        }
      } else for (const node of items) node.h = 0;
      const communities = groups.labels.flatMap((label, index) => {
        const members = items.filter((node) => node.cluster === label.id);
        if (members.length < 2) return [];
        const world = communityOutline(members.map((node) => ({ x: node.x, y: node.y })), BLOB_PAD);
        const outline = world.map((point) => project(point.x, point.y, ground ? ground.sample(point.x, point.y) : 0, width, height));
        return outline.length >= 3 ? [{ label, members, outline, color: communityColors[index % communityColors.length] }] : [];
      });
      for (const community of communities) {
        traceBlob(context, community.outline);
        context.fillStyle = community.color.fill;
        context.fill();
      }
      if (!scene || surface === 'star') for (const edge of edges) {
        const left = byId.get(edge.from); const right = byId.get(edge.to); if (!left || !right) continue;
        const from = project(left.x, left.y, left.h, width, height); const to = project(right.x, right.y, right.h, width, height);
        context.strokeStyle = left.cluster === right.cluster ? 'rgba(176, 176, 186, 0.55)' : 'rgba(140, 140, 150, 0.28)';
        context.lineWidth = 1; context.beginPath(); context.moveTo(from.x, from.y); context.lineTo(to.x, to.y); context.stroke();
      }
      const captions = new Map(groups.labels.map((label) => [label.id, label.name]));
      const labeled = new Set(items.filter((node) => (node.id === selectedId || (!scene && items.length <= 24) || node.h >= 0.62) && node.title !== captions.get(node.cluster)).map((node) => node.id));
      const drawOrder = [...items].sort((left, right) => left.h - right.h);
      for (const node of drawOrder) {
        const point = project(node.x, node.y, node.h, width, height); context.fillStyle = colorOf(node); context.beginPath(); context.arc(point.x, point.y, node.id === selectedId ? 8 : 5, 0, Math.PI * 2); context.fill();
      }
      for (const community of communities) {
        traceBlob(context, community.outline);
        context.strokeStyle = community.color.stroke;
        context.lineWidth = 1.5;
        context.stroke();
        const top = community.outline.reduce((best, point) => point.y < best.y ? point : best, community.outline[0]);
        const text = `${community.label.name} ${community.members.length}`;
        context.font = '12px sans-serif';
        const boxWidth = context.measureText(text).width + 16;
        const boxX = top.x - boxWidth / 2;
        const boxY = top.y - 26;
        context.fillStyle = 'rgba(24, 24, 28, 0.92)';
        context.beginPath();
        context.roundRect(boxX, boxY, boxWidth, 22, 8);
        context.fill();
        context.fillStyle = 'rgba(232, 232, 236, 0.95)';
        context.fillText(text, boxX + 8, boxY + 15);
      }
      context.font = '12px sans-serif'; context.fillStyle = 'rgba(214, 214, 214, 0.82)';
      const occupied: Array<{ x: number; y: number; w: number; h: number }> = communities.map((community) => {
        const top = community.outline.reduce((best, point) => point.y < best.y ? point : best, community.outline[0]);
        const text = `${community.label.name} ${community.members.length}`;
        return { x: top.x - context.measureText(text).width / 2 - 8, y: top.y - 28, w: context.measureText(text).width + 16, h: 24 };
      });
      for (const node of drawOrder) if (labeled.has(node.id)) {
        const point = project(node.x, node.y, node.h, width, height);
        const mates = items.filter((item) => item.cluster === node.cluster);
        const cx = mates.reduce((sum, item) => sum + item.x, 0) / mates.length;
        const cy = mates.reduce((sum, item) => sum + item.y, 0) / mates.length;
        const dx = node.x - cx; const dy = node.y - cy; const length = Math.hypot(dx, dy) || 1;
        const text = node.title.slice(0, 16);
        const box = { x: point.x + (dx / length) * 14, y: point.y + (dy / length) * 14 - 8, w: context.measureText(text).width, h: 16 };
        if (occupied.some((item) => box.x < item.x + item.w + 6 && box.x + box.w + 6 > item.x && box.y < item.y + item.h + 4 && box.y + box.h + 4 > item.y)) continue;
        occupied.push(box);
        context.fillText(text, box.x, box.y + 12);
      }
    };
    const loop = () => { if (!running) return; step(true); frame = requestAnimationFrame(loop); };
    if (reduced) { for (let index = 0; index < 90; index += 1) step(true); step(false); } else loop();
    const hit = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect(); const x = event.clientX - rect.left; const y = event.clientY - rect.top;
      let found: Point | undefined; let best = 18;
      for (const node of sim.current) { const point = project(node.x, node.y, node.h, rect.width, rect.height); const distance = Math.hypot(point.x - x, point.y - y); if (distance < best) { best = distance; found = node; } }
      return found;
    };
    const down = (event: PointerEvent) => { canvas.setPointerCapture(event.pointerId); const found = hit(event); drag.current = { x: event.clientX, y: event.clientY, moved: false, id: found?.id }; };
    const move = (event: PointerEvent) => {
      const current = drag.current; if (!current) return; const dx = event.clientX - current.x; const dy = event.clientY - current.y;
      if (Math.hypot(dx, dy) > 4) current.moved = true; current.x = event.clientX; current.y = event.clientY;
      if (scene) { camera.current.yaw += dx * 0.008; camera.current.pitch = Math.max(0.45, Math.min(1.25, camera.current.pitch - dy * 0.004)); }
      else { camera.current.panX += dx; camera.current.panY += dy; }
      if (reduced) step(false);
    };
    const up = () => { const current = drag.current; drag.current = null; if (!current?.moved && current?.id) { const node = sim.current.find((item) => item.id === current.id); if (node) selectRef.current(node); } };
    const wheel = (event: WheelEvent) => { event.preventDefault(); camera.current.scale = Math.max(0.45, Math.min(2.4, camera.current.scale * (event.deltaY > 0 ? 0.92 : 1.08))); if (reduced) step(false); };
    canvas.addEventListener('pointerdown', down); canvas.addEventListener('pointermove', move); canvas.addEventListener('pointerup', up); canvas.addEventListener('wheel', wheel, { passive: false });
    return () => { running = false; cancelAnimationFrame(frame); canvas.removeEventListener('pointerdown', down); canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerup', up); canvas.removeEventListener('wheel', wheel); };
  }, [nodes, edges, selectedId, spatial, surface, relief, groups]);
  return <div>
    <div className="relative">
    <canvas ref={canvasRef} aria-label="知识关系图" className="h-[28rem] w-full rounded-xl bg-neutral-950 md:h-[36rem]" />
    {spatial === '3d' && <div className="absolute inset-x-3 bottom-3 max-w-md space-y-2 rounded-xl bg-neutral-950/88 p-3 text-neutral-100">
      <div className="flex flex-wrap gap-2" role="group" aria-label="三维视图">
        <Button size="sm" variant={surface === 'terrain' ? 'secondary' : 'ghost'} aria-pressed={surface === 'terrain'} onClick={() => setSurface('terrain')}>地形</Button>
        <Button size="sm" variant={surface === 'star' ? 'secondary' : 'ghost'} aria-pressed={surface === 'star'} onClick={() => setSurface('star')}>知识星图</Button>
      </div>
      {surface === 'terrain' ? <>
        <p className="text-xs text-neutral-300">高度代表什么？</p>
        <div className="flex flex-wrap gap-1" role="group" aria-label="高度代表什么">{([['influence', '影响力'], ['structure', '结构'], ['form', '形态'], ['growth', '增长']] as const).map(([id, label]) => <Button key={id} size="sm" variant={relief === id ? 'secondary' : 'ghost'} aria-pressed={relief === id} onClick={() => setRelief(id)}>{label}</Button>)}</div>
        <p className="text-xs text-neutral-300">{reliefCopy[relief]}</p>
      </> : <p className="text-xs text-neutral-300">知识星图把节点和连线铺在透视平面上。</p>}
    </div>}
    </div>
    {groups.labels.length > 0 && <div role="group" aria-label="聚类" className="mt-2 flex flex-wrap gap-x-3 text-xs text-muted-foreground">{groups.labels.map((label) => <span key={label.id}>{label.name}</span>)}</div>}
  </div>;
}
