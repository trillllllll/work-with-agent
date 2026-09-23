export const memoryKindNames = { fact: '事实', decision: '决策', constraint: '约束', learning: '经验', question: '未决问题', crystal: '结晶' } as const;
export const originNames = { manual: '人工', ai: '外部 AI', mcp: 'MCP' } as const;
export const entityKindNames = { concept: '概念', person: '人物', tool: '工具', project: '项目', other: '其他' } as const;
export const relationNames: Record<string, string> = { evidence: '依据', crystallized_from: '结晶来源', label: '标签', mentions: '提及', attached: '挂在任务', produced: '产物', related: '相关', about: '关于', contrasts: '冲突' };

export type MemoryCardData = { id: string; title: string; content?: string; excerpt?: string; kind?: string; importance?: number; labels?: unknown; origin?: string; status?: string; health?: string; revision?: number; createdAt?: string; updatedAt?: string };

export function asLabels(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  if (typeof value !== 'string' || !value.trim()) return [];
  try { return asLabels(JSON.parse(value)); } catch { return []; }
}

export function relativeTime(iso?: string) {
  if (!iso) return '';
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(minutes)) return '';
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

export function memoryExcerpt(memory: MemoryCardData) {
  return (memory.content || memory.excerpt || '').replace(/\s+/g, ' ').trim();
}

export function Stars({ value = 3, onChange }: { value?: number; onChange?: (value: number) => void }) {
  const stars = [1, 2, 3, 4, 5];
  if (!onChange) return <span aria-label={`重要度 ${value}，满分 5`} className="text-amber-500">{stars.map((star) => star <= value ? '★' : '☆').join('')}</span>;
  return <div role="radiogroup" aria-label="重要度" className="flex gap-1">{stars.map((star) => <button key={star} type="button" role="radio" aria-checked={value === star} aria-label={`${star} 星`} className={`text-lg leading-none ${star <= value ? 'text-amber-500' : 'text-muted-foreground'}`} onClick={() => onChange(star)}>{star <= value ? '★' : '☆'}</button>)}</div>;
}

export function MemorySummary({ memory, selected, onSelect }: { memory: MemoryCardData; selected?: boolean; onSelect?: () => void }) {
  const labels = asLabels(memory.labels);
  const excerpt = memoryExcerpt(memory);
  const status = memory.status === 'superseded' ? '已替代' : memory.status && memory.status !== 'active' ? '历史' : '';
  return <button type="button" onClick={onSelect} className={`w-full rounded-xl text-left ${selected ? 'ring-1 ring-primary/40' : ''}`} aria-pressed={selected}>
    <span className="flex flex-wrap items-start justify-between gap-3">
      <strong className="text-sm">{memory.title}</strong>
      <Stars value={memory.importance ?? 3} />
    </span>
    {excerpt && <span className="mt-2 line-clamp-2 block text-sm text-muted-foreground">{excerpt}</span>}
    <span className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span className="rounded-full bg-muted px-2 py-0.5 text-foreground">{memoryKindNames[memory.kind as keyof typeof memoryKindNames] ?? memory.kind ?? '记忆'}</span>
      <span>{originNames[memory.origin as keyof typeof originNames] ?? '人工'} · {relativeTime(memory.updatedAt || memory.createdAt)}</span>
      {memory.health && memory.health !== 'current' && <span>来源待复核</span>}
      {status && <span>{status}</span>}
      {labels.map((label) => <span key={label} className="rounded-full border px-2 py-0.5">{label}</span>)}
    </span>
  </button>;
}
