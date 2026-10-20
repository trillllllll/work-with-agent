import { describe, it, expect } from 'vitest';
import { applyMessageEvent, type ChatMessage } from './chat.js';
import { readMessageBlocks } from './lib/message-blocks.js';
const initial: ChatMessage[] = [{ id: 'message', role: 'assistant', status: 'streaming', content: '' }];
const start = { type: 'block_start', messageId: 'message', blockId: 'block', index: 0, blockType: 'pending' as const };
describe('content block event replay', () => {
  it('deduplicates starts, offsets and commits, preserving mixed order', () => {
    let messages = applyMessageEvent(initial, start); messages = applyMessageEvent(messages, start);
    const delta = { type: 'block_delta', messageId: 'message', blockId: 'block', delta: '你好😀', offset: 0 };
    messages = applyMessageEvent(messages, delta); messages = applyMessageEvent(messages, delta);
    const commit = { type: 'block_commit', messageId: 'message', blockId: 'block', block: { id: 'block', index: 0, type: 'text' as const, status: 'ready' as const, markdown: '你好😀' } };
    messages = applyMessageEvent(messages, commit); messages = applyMessageEvent(messages, commit);
    messages = applyMessageEvent(messages, { type: 'block_commit', messageId: 'message', blockId: 'image', block: { id: 'image', index: 1, type: 'mermaid', status: 'ready', source: 'flowchart LR;A-->B' } });
    messages = applyMessageEvent(messages, delta);
    expect(messages[0].blocks?.map((block) => block.id)).toEqual(['block', 'image']);
    expect(messages[0].blocks?.[0].markdown).toBe('你好😀'); expect(initial[0].blocks).toBeUndefined();
  });
  it('requests a snapshot on missing or conflicting offsets', () => {
    const started = applyMessageEvent(initial, start);
    const result = applyMessageEvent(started, { type: 'block_delta', messageId: 'message', blockId: 'block', delta: '漏字', offset: 5 });
    expect(result[0].needsSnapshot).toBe(true); expect(result[0].blocks?.[0].markdown).toBeUndefined();
  });
  it('leaves valid blocks visible when a later block fails and reloads the same snapshot', () => {
    let messages = applyMessageEvent(initial, start);
    messages = applyMessageEvent(messages, { type: 'block_error', messageId: 'message', blockId: 'block', message: '未完成' });
    expect(messages[0].blocks?.[0]).toMatchObject({ id: 'block', status: 'error', error: '未完成' });
    expect(readMessageBlocks(JSON.stringify({ schemaVersion: 1, blocks: messages[0].blocks }))).toEqual(messages[0].blocks);
    expect(readMessageBlocks('{"schemaVersion":99,"blocks":[]}')).toEqual([]);
  });
});
