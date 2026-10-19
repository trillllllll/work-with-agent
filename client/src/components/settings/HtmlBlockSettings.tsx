import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { Button } from '@/components/ui/button.js';
import { Label } from '@/components/ui/label.js';
import { Textarea } from '@/components/ui/textarea.js';
import { htmlBlockSettingsKey, useHtmlBlockSettings, type HtmlBlockSettings as Settings } from '@/components/chat/HtmlBlock.js';

const lines = (value: string) => value.split('\n').map((line) => line.trim()).filter(Boolean);

export function HtmlBlockSettings() {
  const client = useQueryClient();
  const settings = useHtmlBlockSettings();
  const [cdn, setCdn] = useState('');
  // The switch flips at once and falls back to the saved value once the server answers.
  const [pendingEnabled, setPendingEnabled] = useState<boolean | null>(null);
  // Fill the textarea once; later refreshes must not wipe an edit in progress.
  const filled = useRef(false);
  useEffect(() => { if (settings.data && !filled.current) { filled.current = true; setCdn(settings.data.cdn.join('\n')); } }, [settings.data]);
  const save = useMutation({
    mutationFn: (body: { enabled?: boolean; cdn?: string[] }) => api<Settings>('/api/settings/html-blocks', { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: (data, body) => { client.setQueryData(htmlBlockSettingsKey, data); setPendingEnabled(null); if (body.cdn) setCdn(data.cdn.join('\n')); toast.success(body.enabled === undefined ? '允许的脚本来源已保存' : data.enabled ? '交互页面已开启' : '交互页面已关闭'); },
    onError: (error) => { setPendingEnabled(null); toast.error(error.message); },
  });
  const data = settings.data;
  return <section className="mt-8 border-t pt-8" aria-label="交互页面设置"><h2 className="text-lg font-semibold">交互页面</h2>
    <p className="mt-1 text-sm text-muted-foreground">允许助手在回复里放可以点选的小页面。页面在隔离环境中运行，不能联网、不能读取应用数据，只能把内容填进输入框，由你决定是否发送。</p>
    {settings.isError ? <p role="alert" className="mt-3 text-sm">配置读取失败。<Button variant="ghost" size="sm" onClick={() => void settings.refetch()}>重试</Button></p> : <div className="mt-4 space-y-4">
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-4" checked={pendingEnabled ?? data?.enabled ?? false} disabled={!data} onChange={(event) => { setPendingEnabled(event.target.checked); save.mutate({ enabled: event.target.checked }); }} />允许助手使用交互页面</label>
      <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); save.mutate({ cdn: lines(cdn) }); }}>
        <Label htmlFor="html-cdn-allowlist">允许加载脚本和样式的来源</Label>
        <Textarea id="html-cdn-allowlist" rows={4} spellCheck={false} className="font-mono text-xs" value={cdn} disabled={!data || save.isPending} onChange={(event) => setCdn(event.target.value)} />
        <p className="text-xs text-muted-foreground">每行一个 https 来源，例如 https://cdn.jsdelivr.net。只能加载固定版本的文件；其他网络请求一律禁止。</p>
        <div className="flex flex-wrap gap-2"><Button type="submit" disabled={!data || save.isPending}>保存来源</Button><Button type="button" variant="outline" disabled={!data || save.isPending} onClick={() => { if (data) { setCdn(data.defaults.join('\n')); save.mutate({ cdn: data.defaults }); } }}>恢复默认</Button></div>
      </form>
    </div>}
  </section>;
}
