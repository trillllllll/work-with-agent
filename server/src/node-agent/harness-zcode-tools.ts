import { asObject } from './harness-codex.js';
import { codexText as text } from './harness-history.js';
import type { HarnessTool } from './harness-protocol.js';
import { harnessOutput } from './harness-tools.js';

function statusOf(status: unknown): HarnessTool['status'] {
  switch (status) {
    case 'inputStreaming':
    case 'pendingApproval':
    case 'running': return 'running';
    case 'success': return 'completed';
    case 'error': return 'failed';
    case 'cancelled': return 'interrupted';
    default: return 'unknown';
  }
}

export function zcodeHarnessTool(item: Record<string, unknown>, turnId: string): HarnessTool | null {
  const id = text(item.id);
  if (item.kind !== 'toolCall' || !id || id.length > 200 || !turnId) return null;
  const name = text(item.toolName);
  const status = statusOf(item.status);
  const result = asObject(item.output);
  const display = asObject(result.display);
  const preview = asObject(item.outputPreview);
  const filePath = display.kind === 'file_diff' ? text(display.filePath).slice(0, 600) : '';
  const command = name.toLowerCase() === 'bash';
  const finalOutput = (display.kind === 'bash_output' ? text(display.output) : '') || text(result.text);
  const previewText = text(preview.fullText) || text(preview.text);
  const progress = asObject(item.progress);
  const value = (status === 'running' ? previewText : finalOutput) || finalOutput ||
    text(progress.previewLine) || text(progress.message) || text(asObject(item.error).message);
  const output = harnessOutput(value);
  const truncated = output.truncated || Boolean(result.truncated) || display.truncated === true ||
    (status === 'running' && typeof preview.totalLines === 'number' && preview.totalLines > previewText.split('\n').length);
  const exitCode = command && typeof result.exitCode === 'number' && Number.isSafeInteger(result.exitCode) ? result.exitCode : undefined;
  // Use the display output and Bash command only. Tool inputs, binary payloads and retained output paths stay on the Mac.
  return { id, turnId, status, kind: command ? 'command' : filePath ? 'fileChange' : 'tool',
    title: ((command && text(asObject(item.input).command)) || name).slice(0, 1_000),
    ...(filePath ? { files: [filePath] } : {}), ...(output.output ? { output: output.output, truncated } : {}),
    ...(exitCode === undefined ? {} : { exitCode }) };
}
