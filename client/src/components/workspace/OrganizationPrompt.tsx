import { useState } from 'react';
import { toast } from 'sonner';
import { organizationMcpPrompt } from '@/lib/organization-prompt.js';
import { Button } from '@/components/ui/button.js';

export function OrganizationPrompt({ id, purpose }: { id: string; purpose: string }) {
  const [copied, setCopied] = useState(false);
  const prompt = organizationMcpPrompt({ id, purpose });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
    } catch {
      toast.error('复制失败，请手动选择提示词');
    }
  };
  return <div className="space-y-2"><p className="text-xs text-muted-foreground">复制下面的提示词，粘贴到已连接 work_with_agent 的 AI 会话。</p><pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-3 text-xs" aria-label={`整理提示词 ${id}`}>{prompt}</pre><Button type="button" variant="outline" size="sm" aria-label={`复制整理提示词 ${id}`} onClick={() => void copy()}>{copied ? '已复制' : '复制提示词'}</Button></div>;
}
