import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../domain/task.js';
import { redact } from '../infrastructure/controlled-execution.js';
import { codePoints } from './text.js';

const item = (max: number) => z.string().refine((value) => codePoints(value) <= max, `每一项不能超过 ${max} 个字符`);

export const externalPromptInput = z.object({
  capability: z.enum(['web_research', 'local_execution', 'external_application', 'other']),
  limitation: z.string().refine((value) => { const n = codePoints(value); return n >= 1 && n <= 300; }, 'limitation 需要 1～300 个字符'),
  goal: z.string().refine((value) => { const n = codePoints(value); return n >= 1 && n <= 1000; }, 'goal 需要 1～1000 个字符'),
  background: z.array(item(1000)).max(8),
  constraints: z.array(item(500)).max(10),
  expectedOutput: z.array(item(500)).min(1).max(10),
}).strict();

export type ExternalPromptInput = z.infer<typeof externalPromptInput>;

const titles: Record<ExternalPromptInput['capability'], string> = {
  web_research: '需要具备联网能力的 AI',
  local_execution: '需要具备本机执行能力的 AI',
  external_application: '需要能操作外部应用的 AI',
  other: '需要其他工具能力的 AI',
};

export function renderExternalPrompt(input: ExternalPromptInput) {
  const lines = [
    '目标',
    input.goal,
    '',
    '已知背景',
    input.background.length ? input.background.map((entry) => `- ${entry}`).join('\n') : '- 无',
    '',
    '要求与限制',
    input.constraints.length ? input.constraints.map((entry) => `- ${entry}`).join('\n') : '- 无',
    '',
    '请按以下格式返回',
    input.expectedOutput.map((entry) => `- ${entry}`).join('\n'),
    '',
    '真实性要求',
    '- 区分已核实事实、推断和待确认内容。',
    '- 不具备所需能力时明确说明，不要编造执行结果。',
    '- 如果需要联网，提供支持结论的来源链接与日期。',
    '- 如果需要修改文件或外部系统，先给出操作范围和预期影响。',
  ];
  const rendered = lines.join('\n');
  if (codePoints(rendered) > 12_000) throw new DomainError('PROMPT_TOO_LONG', '提示词超过 12000 字，请减少背景或限制后再生成', 400);
  const prompt = redact(rendered);
  return typeof prompt === 'string' ? prompt : rendered;
}

export function externalPromptPart(messageId: string, toolCallId: string, input: ExternalPromptInput, prompt: string) {
  return {
    schemaVersion: 1 as const,
    type: 'external_prompt' as const,
    id: createHash('sha256').update(`${messageId}:${toolCallId}`).digest('hex').slice(0, 32),
    capability: input.capability,
    limitation: input.limitation,
    title: titles[input.capability],
    prompt,
  };
}
