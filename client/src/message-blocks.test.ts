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

describe('source and chart recovery', () => {
  const source = { type: 'block_source_delta', messageId: 'message', blockId: 'block', blockType: 'svg' as const, offset: 0, delta: '<svg>😀' };
  const previewSpec = { kind: 'pie' as const, title: '预览', values: [{ name: 'A', value: 1 }], provenance: { kind: 'unverified' as const, label: '未核验' } };
  const chart = { type: 'block_chart_preview', messageId: 'message', blockId: 'block', revision: 1, previewSpec };
  it('deduplicates source and restores conflicts or gaps from a snapshot', () => {
    const applied = applyMessageEvent(applyMessageEvent(initial, start), source);
    expect(applyMessageEvent(applied, source)).toEqual(applied);
    for (const change of [{ offset: 99 }, { delta: 'conflict' }, { offset: -1 }, { blockType: 'html' as const }]) expect(applyMessageEvent(applied, { ...source, ...change })[0].needsSnapshot).toBe(true);
    expect(readMessageBlocks(JSON.stringify({ schemaVersion: 1, blocks: applied[0].blocks }))).toEqual(applied[0].blocks);
  });
  it('accepts only monotonic chart revisions, rejects changed duplicates and gaps', () => {
    const applied = applyMessageEvent(applyMessageEvent(initial, start), chart);
    expect(applyMessageEvent(applied, chart)).toEqual(applied);
    expect(applyMessageEvent(applied, { ...chart, previewSpec: { ...previewSpec, title: 'conflict' } })[0].needsSnapshot).toBe(true);
    expect(applyMessageEvent(applied, { ...chart, revision: 3 })[0].needsSnapshot).toBe(true);
    expect(applyMessageEvent(applied, { ...chart, revision: 2 })[0].blocks?.[0].previewRevision).toBe(2);
  });
  it.each(['completed', 'failed'] as const)('ignores late increments after message %s', status => {
    const ended = [{ ...initial[0], status }];
    for (const event of [source, chart, start]) expect(applyMessageEvent(ended, event)).toEqual(ended);
  });
  it('keeps source/preview on block errors and ignores late increments', () => {
    for (const event of [source, chart]) {
      const applied = applyMessageEvent(applyMessageEvent(initial, start), event);
      const failed = applyMessageEvent(applied, { ...start, type: 'block_error', message: '未完成' });
      expect(failed[0].blocks?.[0]).toMatchObject({ ...applied[0].blocks?.[0], status: 'error', error: '未完成' });
      expect(applyMessageEvent(failed, event)).toEqual(failed);
    }
  });
});
