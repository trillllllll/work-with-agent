import { useEffect, useRef } from 'react';
import { systemNotify } from '@/lib/desktop-shell.js';
import { pauseReasonLabels } from '@/components/orchestration/labels.js';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

/** 任务文字保存等高频变更只刷新任务相关查询；未挂载的 query 失效只标脏、不发请求。 */
const TASK_SCOPES = ['tasks', 'task', 'changes', 'task-topic-history', 'trash'] as const;
/** 同一突发的 change 事件合并成一轮失效，以首个事件起算，延迟有上界。 */
const COALESCE_MS = 300;

function scopeOf(message: MessageEvent): readonly string[] | 'all' {
  try {
    const event = JSON.parse(message.data);
    if (Array.isArray(event?.affectedTaskIds) && event.affectedTaskIds.length > 0) return TASK_SCOPES;
  } catch { /* 无载荷或无法解析的事件按全量处理。 */ }
  return 'all';
}

export function useWorkspaceEvents() {
  const { t } = useTranslation('app');
  // Translate when the event arrives, without reopening the stream if the language changes.
  const tRef = useRef(t);
  tRef.current = t;
  const client = useQueryClient();
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') void client.invalidateQueries(); };
    const events = new EventSource('/api/v1/events', { withCredentials: true });
    const notified = new Set<string>();
    const pending = new Set<string>();
    let pendingAll = false;
    let timer: number | undefined;
    const flush = () => {
      timer = undefined;
      if (document.visibilityState !== 'visible') {
        // 隐藏期间不做后台刷新；focus/visibilitychange 与 30s 兜底会补上。
        pending.clear();
        pendingAll = false;
        return;
      }
      if (pendingAll) {
        pendingAll = false;
        pending.clear();
        void client.invalidateQueries();
        return;
      }
      const scopes = [...pending];
      pending.clear();
      for (const key of scopes) void client.invalidateQueries({ queryKey: [key] });
    };
    const changed = (message: MessageEvent) => {
      const scope = scopeOf(message);
      if (scope === 'all') pendingAll = true;
      else for (const key of scope) pending.add(key);
      if (timer === undefined) timer = window.setTimeout(flush, COALESCE_MS);
      try {
        const event = JSON.parse(message.data);
        const key = `${event.batchId}:${event.status}`;
        if (event.kind === 'orchestration' && event.attention && !notified.has(`orch:${event.orchestrationId}:${event.status}:${event.pauseReason ?? ''}`)) {
          notified.add(`orch:${event.orchestrationId}:${event.status}:${event.pauseReason ?? ''}`);
          const translate = tRef.current;
          const accepting = event.status === 'awaiting_acceptance';
          if (accepting) toast.success(translate('orchestration:notify.doneToast'));
          else toast.warning(translate('orchestration:notify.pausedToast'));
          const reason = pauseReasonLabels[event.pauseReason ?? ''] ?? event.pauseReason ?? '';
          void systemNotify(accepting ? translate('orchestration:notify.acceptTitle') : translate('orchestration:notify.pausedTitle'), accepting ? translate('orchestration:notify.acceptBody') : translate('orchestration:notify.pausedBody', { reason }), `orch:${event.orchestrationId}`);
        }
        if (event.kind === 'review' && !notified.has(key)) {
          notified.add(key);
          const message = event.status === 'ready' ? tRef.current('review.ready') : event.status === 'failed' ? tRef.current('review.failed') : tRef.current('review.partial');
          toast.info(message, { action: { label: tRef.current('review.view'), onClick: () => { window.location.hash = '/reviews'; } } });
        }
      } catch { /* Other invalidation events carry no user notification. */ }
    };
    events.onmessage = refresh;
    events.onopen = refresh;
    events.addEventListener('change', changed as EventListener);
    for (const name of ['changed', 'workspace', 'mutation']) events.addEventListener(name, refresh);
    const interval = window.setInterval(refresh, 30_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { events.close(); if (timer !== undefined) window.clearTimeout(timer); clearInterval(interval); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [client]);
}
