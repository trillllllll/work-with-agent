import { verifyChartSource } from './chart-source.js';
import { prisma } from '../infrastructure/prisma.js';
import { DomainError } from '../domain/task.js';
import type { ChatEvent } from '../agent.js';
import { appendRunEvent } from './events.js';
import { ReplyParser } from './reply-parser.js';
import { TextBatcher } from './text-batcher.js';
import { projectBlocks, validateReplyBlock, type BlockEvent, type ContentBlock, type ImageResult } from './content-blocks.js';

/** One presentation call, one ordered set of blocks, one serialized persistence lane. */
export class ReplyStream {
  private parser = new ReplyParser();
  private blocks: ContentBlock[] = [];
  private batchers = new Map<number, TextBatcher>();
  private receivedText = new Map<number, string>();
  private lane: Promise<void> = Promise.resolve();
  private prefixCount = 0;
  constructor(private runId: string, private token: string, private conversationId: string, private messageId: string,
    private images: (searchId: string, ids: string[]) => Promise<ImageResult[]>, private abort: () => void, prefix: string) {
    if (prefix) { this.prefixCount = 1; this.blocks.push({ id: `${messageId}:0`, index: 0, type: 'text', status: 'ready', markdown: prefix }); }
  }
  private async persist(event: BlockEvent, update: () => void) {
    const operation = this.lane.then(async () => {
      await prisma.$transaction(async (tx) => {
        const run = await tx.agentRun.findUnique({ where: { id: this.runId } });
        const conversation = await tx.conversation.findUnique({ where: { id: this.conversationId }, select: { activeRunId: true } });
        if (!run || run.leaseToken !== this.token || run.state !== 'running' || !run.leaseExpiresAt || run.leaseExpiresAt <= new Date().toISOString() || conversation?.activeRunId !== this.runId) throw new DomainError('LEASE_LOST', '这次请求已停止或失去执行权', 409);
        update();
        await tx.message.update({ where: { id: this.messageId }, data: { blocksJson: JSON.stringify({ schemaVersion: 1, blocks: this.blocks }), content: projectBlocks(this.blocks) } });
        await appendRunEvent(tx, this.runId, event.type, { ...event, runId: this.runId, conversationId: this.conversationId, messageId: this.messageId } as ChatEvent);
      });
    });
    this.lane = operation;
    await operation;
  }
  private async events() {
    for (const event of this.parser.drain()) {
      const index = event.index + this.prefixCount;
      const id = `${this.messageId}:${index}`;
      if (event.kind === 'start') {
        if (index === 1 && this.prefixCount && this.blocks.length === 1) {
          const prefix = this.blocks[0];
          await this.persist({ type: 'block_commit', blockId: prefix.id, index: 0, block: prefix }, () => {});
        }
        await this.persist({ type: 'block_start', blockId: id, index, blockType: 'pending' }, () => { this.blocks[index] = { id, index, type: 'pending', status: 'pending' }; });
      } else if (event.kind === 'text') {
        const previous = this.receivedText.get(index) ?? '';
        if (!event.text.startsWith(previous)) throw new Error('文字增量发生冲突');
        const delta = event.text.slice(previous.length);
        this.receivedText.set(index, event.text);
        if (!delta) continue;
        let batcher = this.batchers.get(index);
        if (!batcher) {
          batcher = new TextBatcher(async (text) => {
            const block = this.blocks[index];
            const offset = block.markdown?.length ?? 0;
            await this.persist({ type: 'block_delta', blockId: id, offset, delta: text }, () => { block.type = 'text'; block.markdown = (block.markdown ?? '') + text; });
          }, this.abort);
          this.batchers.set(index, batcher);
        }
        await batcher.add(delta);
      } else {
        await this.batchers.get(index)?.finish();
        try {
          const validated = await validateReplyBlock(event.value, this.images, (spec) => verifyChartSource(this.conversationId, spec));
          const block: ContentBlock = { ...validated, id, index, status: 'ready' };
          await this.persist({ type: 'block_commit', blockId: id, block }, () => { this.blocks[index] = block; });
        } catch (error) {
          if (error instanceof DomainError && error.code === 'LEASE_LOST') throw error;
          const raw = event.value && typeof event.value === 'object' ? event.value as Record<string, unknown> : {};
          const retained = ['mermaid', 'svg'].includes(String(raw.type)) && typeof raw.source === 'string' ? { type: raw.type as 'mermaid' | 'svg', source: raw.source.slice(0, 65536), ...(typeof raw.title === 'string' ? { title: raw.title.slice(0, 300) } : {}) } : {};
          await this.blockError(index, error instanceof Error ? error.message.slice(0, 300) : '内容无法显示', retained);
        }
      }
    }
  }
  async write(delta: string) {
    let failure: unknown;
    try { this.parser.write(delta); } catch (error) { failure = error; }
    await this.events();
    if (failure) throw failure;
  }
  private async blockError(index: number, message: string, retained: Partial<ContentBlock> = {}) {
    const block = { ...this.blocks[index], ...retained, status: 'error' as const, error: message };
    await this.persist({ type: 'block_error', blockId: block.id, code: 'INVALID_REPLY_BLOCK', message }, () => { this.blocks[index] = block; });
  }
  async finish() {
    this.parser.finish();
    await this.events();
    for (const batcher of this.batchers.values()) await batcher.finish();
    await this.lane;
    return projectBlocks(this.blocks);
  }
  async fail(message: string) {
    for (const batcher of this.batchers.values()) await batcher.finish();
    for (const block of this.blocks) if (block.status === 'pending') await this.blockError(block.index, message);
    await this.lane;
    return projectBlocks(this.blocks);
  }
}
