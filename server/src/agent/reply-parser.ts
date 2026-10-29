import { Tokenizer, TokenType } from '@streamparser/json';

export type ReplyParseEvent = { kind: 'start'; index: number } | { kind: 'text'; index: number; text: string; studySupport?: 'hint' | 'solution' } | { kind: 'block'; index: number; value: unknown };
type Frame = { value: Record<string, unknown> | unknown[]; path: Array<string | number>; state: 'keyOrEnd' | 'key' | 'colon' | 'valueOrEnd' | 'value' | 'commaOrEnd'; key?: string; keys: Set<string>; partialText?: string };
const invalid = (message: string) => Object.assign(new Error(message), { code: 'INVALID_REPLY_STREAM' });

/** Real token/structure parsing; partial values never go through JSON.parse. */
export class ReplyParser {
  private tokenizer = new Tokenizer({ emitPartialTokens: true });
  private stack: Frame[] = [];
  private root?: Record<string, unknown>;
  private events: ReplyParseEvent[] = [];
  private bytes = 0;
  private ended = false;
  private failed: unknown;
  private highSurrogate = '';
  constructor() {
    this.tokenizer.onToken = ({ token, value, partial }) => this.token(token, value, Boolean(partial));
  }
  private blockIndex(frame: Frame) { return frame.path.length === 2 && frame.path[0] === 'blocks' && typeof frame.path[1] === 'number' ? frame.path[1] : null; }
  private text(frame: Frame, text: string) {
    const index = this.blockIndex(frame);
    if (index === null || (frame.value as Record<string, unknown>).type !== 'text') return;
    // Never publish half a surrogate pair, even if the upstream string is split there.
    const safe = /[\uD800-\uDBFF]$/.test(text) ? text.slice(0, -1) : text;
    const support = (frame.value as Record<string, unknown>).studySupport;
    this.events.push({ kind: 'text', index, text: safe, ...(support === 'hint' || support === 'solution' ? { studySupport: support } : {}) });
  }
  private accept(value: unknown) {
    const parent = this.stack.at(-1);
    if (!parent) {
      if (this.root || !value || typeof value !== 'object' || Array.isArray(value)) throw invalid('回复根节点必须是单个对象');
      this.root = value as Record<string, unknown>;
      return [];
    }
    if (parent.state !== 'value' && parent.state !== 'valueOrEnd') throw invalid('JSON 值的位置无效');
    const key = Array.isArray(parent.value) ? parent.value.length : parent.key!;
    const path = [...parent.path, key];
    if (Array.isArray(parent.value)) parent.value.push(value);
    else parent.value[key] = value;
    parent.state = 'commaOrEnd';
    return path;
  }
  private token(token: TokenType, value: unknown, partial: boolean) {
    const frame = this.stack.at(-1);
    if (typeof value === 'string' && value.length > 65536) throw invalid('单字段超过大小限制');
    if (partial) {
      if (token === TokenType.STRING && frame?.state === 'value' && frame.key === 'markdown') {
        frame.partialText = String(value); this.text(frame, frame.partialText);
      }
      return;
    }
    if (token === TokenType.LEFT_BRACE || token === TokenType.LEFT_BRACKET) {
      const array = token === TokenType.LEFT_BRACKET;
      const object = array ? [] : Object.create(null) as Record<string, unknown>;
      const path = this.accept(object);
      if (path.length === 1 && (path[0] !== 'blocks' || !array)) throw invalid('根节点只允许 blocks 数组');
      if (path.length === 2 && path[0] === 'blocks') {
        if (array || Number(path[1]) >= 32) throw invalid('内容块类型或数量无效');
        this.events.push({ kind: 'start', index: Number(path[1]) });
      }
      if (this.stack.length >= 16) throw invalid('回复结构嵌套过深');
      this.stack.push({ value: object, path, state: array ? 'valueOrEnd' : 'keyOrEnd', keys: new Set() });
      return;
    }
    if (!frame) throw invalid('JSON 根节点之外出现内容');
    if (token === TokenType.RIGHT_BRACE || token === TokenType.RIGHT_BRACKET) {
      const array = token === TokenType.RIGHT_BRACKET;
      if (array !== Array.isArray(frame.value) || !['commaOrEnd', array ? 'valueOrEnd' : 'keyOrEnd'].includes(frame.state)) throw invalid('JSON 对象未完整结束');
      this.stack.pop();
      const index = this.blockIndex(frame);
      if (index !== null) this.events.push({ kind: 'block', index, value: frame.value });
      if (!this.stack.length) this.ended = true;
      return;
    }
    if (token === TokenType.COMMA) {
      if (frame.state !== 'commaOrEnd') throw invalid('JSON 逗号位置无效');
      frame.state = Array.isArray(frame.value) ? 'value' : 'key'; return;
    }
    if (token === TokenType.COLON) {
      if (frame.state !== 'colon') throw invalid('JSON 冒号位置无效');
      frame.state = 'value'; return;
    }
    if (!Array.isArray(frame.value) && (frame.state === 'keyOrEnd' || frame.state === 'key')) {
      if (token !== TokenType.STRING || typeof value !== 'string' || frame.keys.has(value)) throw invalid('JSON 字段无效或重复');
      if (!frame.path.length && value !== 'blocks') throw invalid('根节点含未知字段');
      if (['__proto__', 'constructor', 'prototype'].includes(value)) throw invalid('不允许的 JSON 字段');
      frame.keys.add(value); frame.key = value; frame.state = 'colon'; return;
    }
    if (typeof value === 'number' && !Number.isFinite(value)) throw invalid('图表数值必须有限');
    if (frame.path.length === 1 && frame.path[0] === 'blocks') throw invalid('内容块必须是对象');
    if (!frame.path.length) throw invalid('blocks 必须是数组');
    if (frame.key === 'markdown' && typeof value === 'string') { frame.partialText = value; this.text(frame, value); }
    this.accept(value);
    if (frame.key === 'type' && frame.partialText !== undefined) this.text(frame, frame.partialText);
  }
  write(chunk: string | Uint8Array) {
    if (this.failed) throw this.failed;
    this.bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
    if (this.bytes > 512 * 1024) throw invalid('回复超过 512 KiB');
    // The tokenizer accepts bytes directly. Hold raw UTF-16 halves from string APIs.
    let input = chunk;
    if (typeof chunk === 'string') {
      input = this.highSurrogate + chunk;
      this.highSurrogate = /[\uD800-\uDBFF]$/.test(input) ? input.slice(-1) : '';
      if (this.highSurrogate) input = input.slice(0, -1);
    }
    try { this.tokenizer.write(input); } catch (error) { this.failed = error; throw error; }
  }
  drain() { const events = this.events; this.events = []; return events; }
  finish() {
    if (this.failed) throw this.failed;
    if (this.highSurrogate) throw invalid('未完成的 Unicode 字符');
    this.tokenizer.end();
    if (!this.ended || this.stack.length || !Array.isArray(this.root?.blocks) || !this.root.blocks.length) throw invalid('回复结构未完成或没有内容');
  }
}
