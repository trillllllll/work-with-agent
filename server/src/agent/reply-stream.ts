import { sourcePreviewAvailable } from './source-preview.js';
import { verifyChartSource } from './chart-source.js';
import { prisma } from '../infrastructure/prisma.js';
import { DomainError } from '../domain/task.js';
import type { ChatEvent } from '../agent.js';
import { appendRunEvent } from './events.js';
import { ReplyParser } from './reply-parser.js';
import { TextBatcher } from './text-batcher.js';
import { SnapshotBatcher } from './snapshot-batcher.js';
import type { ChartSpec } from './content-blocks.js';
import { htmlBlockPolicy } from '../application/html-block-settings.js';
import type { HtmlBlockPolicy } from './html-block.js';
import { projectBlocks, validateReplyBlock, type BlockEvent, type ContentBlock, type ImageResult } from './content-blocks.js';

/** One presentation call, one ordered set of blocks, one serialized persistence lane. */
export class ReplyStream {
  private parser = new ReplyParser();
  private blocks: ContentBlock[] = [];
  private batchers = new Map<number, TextBatcher>();
  private sourceBatchers = new Map<number, TextBatcher>();
  private chartBatchers = new Map<number, SnapshotBatcher<ChartSpec>>();
  private receivedSource = new Map<number, string>();
  private studySupport = new Map<number, 'hint' | 'solution'>();
  private receivedText = new Map<number, string>();
  private lane: Promise<void> = Promise.resolve();
  private prefixCount = 0;
  private htmlPolicy?: Promise<HtmlBlockPolicy>;
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
        const supportChanged = event.studySupport && event.studySupport !== this.studySupport.get(index);
        if (event.studySupport) this.studySupport.set(index, event.studySupport);
        if (!delta) {
          if (supportChanged && event.text.trim()) {
            await this.batchers.get(index)?.finish(); this.batchers.delete(index);
            const block = this.blocks[index];
            await this.persist({ type: 'block_delta', blockId: id, offset: block.markdown?.length ?? 0, delta: '', studySupport: event.studySupport, previewAvailable: true }, () => { block.studySupport = event.studySupport; });
          }
          continue;
        }
        let batcher = this.batchers.get(index);
        if (!batcher) {
          batcher = new TextBatcher(async (text) => {
            const block = this.blocks[index];
            const offset = block.markdown?.length ?? 0;
            const support = this.studySupport.get(index);
            await this.persist({ type: 'block_delta', blockId: id, offset, delta: text, ...(support ? { studySupport: support } : {}) }, () => { block.type = 'text'; block.markdown = (block.markdown ?? '') + text; if (support) block.studySupport = support; });
          }, this.abort);
          this.batchers.set(index, batcher);
        }
        await batcher.add(delta);
      } else if (event.kind === 'source') {
        if (event.blockType === 'html') {
          this.htmlPolicy ??= htmlBlockPolicy();
          if (!(await this.htmlPolicy).enabled) continue;
        }
        const previous = this.receivedSource.get(index) ?? '';
        if (!event.source.startsWith(previous)) throw new Error('源码增量发生冲突');
        const delta = event.source.slice(previous.length); this.receivedSource.set(index, event.source);
        if (!delta) continue;
        let batcher = this.sourceBatchers.get(index);
        if (!batcher) {
          batcher = new TextBatcher(async (source) => {
            const block = this.blocks[index]; const offset = block.source?.length ?? 0;
            await this.persist({ type: 'block_source_delta', blockId: id, blockType: event.blockType, renderMode: event.renderMode, offset, delta: source, previewAvailable: sourcePreviewAvailable(event.blockType, (block.source ?? '') + source) }, () => {
              block.type = event.blockType; block.source = (block.source ?? '') + source; block.renderMode = event.renderMode;
            });
          }, this.abort);
          this.sourceBatchers.set(index, batcher);
        }
        await batcher.add(delta);
      } else if (event.kind === 'chart') {
        let batcher = this.chartBatchers.get(index);
        if (!batcher) {
          batcher = new SnapshotBatcher(async (previewSpec) => {
            const block = this.blocks[index]; const revision = (block.previewRevision ?? 0) + 1;
            await this.persist({ type: 'block_chart_preview', blockId: id, revision, previewSpec }, () => {
              block.type = 'chart'; block.previewSpec = previewSpec; block.previewRevision = revision;
            });
          }, this.abort);
          this.chartBatchers.set(index, batcher);
        }
        batcher.add(event.spec);
      } else {
        await this.batchers.get(index)?.finish();
        await this.sourceBatchers.get(index)?.finish();
        await this.chartBatchers.get(index)?.finish();
        try {
          const raw = event.value && typeof event.value === 'object' ? event.value as Record<string, unknown> : {};
          if (raw.type === 'html') this.htmlPolicy ??= htmlBlockPolicy();
          const validated = await validateReplyBlock(event.value, this.images, (spec) => verifyChartSource(this.conversationId, spec), raw.type === 'html' ? await this.htmlPolicy : undefined);
          const block: ContentBlock = { ...validated, id, index, status: 'ready' };
          await this.persist({ type: 'block_commit', blockId: id, block }, () => { this.blocks[index] = block; });
        } catch (error) {
          if (error instanceof DomainError && error.code === 'LEASE_LOST') throw error;
          const raw = event.value && typeof event.value === 'object' ? event.value as Record<string, unknown> : {};
          const retained = ['mermaid', 'svg', 'html'].includes(String(raw.type)) && typeof raw.source === 'string' ? { type: raw.type as 'mermaid' | 'svg' | 'html', source: raw.source.slice(0, 65536), ...(typeof raw.title === 'string' ? { title: raw.title.slice(0, 300) } : {}), ...(raw.type === 'html' && typeof raw.alt === 'string' ? { alt: raw.alt.slice(0, 2000) } : {}) } : {};
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
    for (const batcher of [...this.batchers.values(), ...this.sourceBatchers.values(), ...this.chartBatchers.values()]) await batcher.finish();
    await this.lane;
    return projectBlocks(this.blocks);
  }
  async fail(message: string) {
    for (const batcher of [...this.batchers.values(), ...this.sourceBatchers.values(), ...this.chartBatchers.values()]) await batcher.finish();
    for (const block of this.blocks) if (block.status === 'pending') await this.blockError(block.index, message);
    await this.lane;
    return projectBlocks(this.blocks);
  }
}
