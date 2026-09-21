import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

export function useWorkspaceEvents() {
  const client = useQueryClient();
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') void client.invalidateQueries(); };
    const events = new EventSource('/api/v1/events', { withCredentials: true });
    const notified = new Set<string>();
    const changed = (message: MessageEvent) => {
      refresh();
      try {
        const event = JSON.parse(message.data);
        const key = `${event.batchId}:${event.status}`;
        if (event.kind === 'review' && !notified.has(key)) {
          notified.add(key);
          const message = event.status === 'ready' ? '新的回顾报告已就绪' : event.status === 'failed' ? '回顾生成失败，可查看原因并重试' : '基础回顾已保存，AI 整理需要处理';
          toast.info(message, { action: { label: '查看回顾', onClick: () => { window.location.hash = '/reviews'; } } });
        }
      } catch { /* Other invalidation events carry no user notification. */ }
    };
    events.onmessage = refresh;
    events.onopen = refresh;
    events.addEventListener('change', changed as EventListener);
    for (const name of ['changed', 'workspace', 'mutation']) events.addEventListener(name, refresh);
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { events.close(); clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [client]);
}
