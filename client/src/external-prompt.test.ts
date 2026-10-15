import { describe, expect, it } from 'vitest';
import { applyMessageEvent, parseExternalParts } from './chat.js';

const part = {
  schemaVersion: 1 as const,
  type: 'external_prompt' as const,
  id: 'prompt-1',
  capability: 'web_research',
  limitation: '我目前不能联网查资料。',
  title: '需要具备联网能力的 AI',
  prompt: '目标\n查一下\n\n请按以下格式返回\n结论',
};

describe('external prompt card data', () => {
  it('keeps the prompt on the assistant message and does not treat it as an approval', () => {
    const messages = applyMessageEvent([{ id: 'm1', role: 'assistant', content: '我目前不能联网查资料。', status: 'completed' }], { type: 'external_prompt', messageId: 'm1', part });
    expect(messages[0]?.parts).toEqual([part]);
    expect(messages[0]?.parts?.[0]?.prompt).toContain('目标');
    expect(messages[0]?.parts?.[0]?.prompt).toContain('请按以下格式返回');
    expect(messages[0]?.parts?.[0]?.prompt).not.toContain('sk-secret');
  });

  it('restores the same card from partsJson', () => {
    expect(parseExternalParts(JSON.stringify([part]))).toEqual([part]);
    expect(parseExternalParts('[]')).toEqual([]);
    expect(parseExternalParts('{oops')).toEqual([]);
  });
});
