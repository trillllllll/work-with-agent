import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Label } from '@/components/ui/label.js';
type ImageSettings = { provider: 'brave'; configured: boolean; keyMasked: string | null; managedBy: 'environment' | 'application' };
export function ImageSearchSettings() {
  const client = useQueryClient(); const [key, setKey] = useState('');
  const settings = useQuery({ queryKey: ['image-search-settings'], queryFn: () => api<ImageSettings>('/api/settings/image-search') });
  const save = useMutation({ mutationFn: (clear: boolean) => api<ImageSettings>('/api/settings/image-search', clear ? { method: 'DELETE' } : { method: 'PATCH', body: JSON.stringify({ apiKey: key.trim() }) }),
    onSuccess: (data) => { client.setQueryData(['image-search-settings'], data); setKey(''); toast.success(data.configured ? '图片搜索密钥已保存，实际搜索时会验证服务' : '图片搜索密钥已清除'); },
    onError: (error) => toast.error(error.message),
  });
  const environment = settings.data?.managedBy === 'environment';
  return <section className="mt-8 border-t pt-8" aria-label="图片搜索设置"><h2 className="text-lg font-semibold">图片搜索</h2><p className="mt-1 text-sm text-muted-foreground">使用 Brave Image Search 为助手提供真实图片和来源。密钥保存在当前工作区的服务端。</p>
    {settings.isError ? <p role="alert" className="mt-3 text-sm">配置读取失败。<Button variant="ghost" size="sm" onClick={() => void settings.refetch()}>重试</Button></p> : <form className="mt-4 space-y-3" onSubmit={(event) => { event.preventDefault(); save.mutate(false); }}>
      <Label htmlFor="brave-image-key">Brave 图片搜索 API Key</Label><Input id="brave-image-key" type="password" autoComplete="new-password" value={key} disabled={environment || save.isPending || settings.isLoading} onChange={(event) => setKey(event.target.value)} placeholder={settings.data?.configured ? `已配置：${settings.data.keyMasked}` : '请输入 Brave Image Search API Key'} />
      <p className="text-xs text-muted-foreground">{environment ? '当前密钥由环境变量管理，请修改对应服务配置。' : settings.data?.configured ? `当前密钥：${settings.data.keyMasked}` : '未配置时，助手会明确说明图片搜索不可用。'}</p>
      {!environment && <div className="flex flex-wrap gap-2"><Button type="submit" disabled={!key.trim() || save.isPending}>保存图片搜索密钥</Button>{settings.data?.configured && <Button type="button" variant="outline" disabled={save.isPending} onClick={() => save.mutate(true)}>清除图片搜索密钥</Button>}</div>}
    </form>}
  </section>;
}
