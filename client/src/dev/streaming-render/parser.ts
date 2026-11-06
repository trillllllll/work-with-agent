// Compatibility adapter for the experiment counters; parsing is shared with production.
import { ReplyParser, type ReplyParseEvent as ProductionEvent } from '../../../../server/src/agent/reply-parser.js';
export type ReplyParseEvent = Exclude<ProductionEvent, { kind: 'chart' }> | { kind: 'chart'; index: number; categories: string[]; values: number[] };
export class ExperimentalReplyParser {
  private parser = new ReplyParser();
  write(chunk: string | Uint8Array) { this.parser.write(chunk); }
  finish() { this.parser.finish(); }
  drain(): ReplyParseEvent[] {
    return this.parser.drain().flatMap((event): ReplyParseEvent[] => {
      if (event.kind !== 'chart') return [event];
      if (event.spec.kind !== 'bar' && event.spec.kind !== 'line') return [];
      return [{ kind: 'chart', index: event.index, categories: event.spec.categories, values: event.spec.series[0].values as number[] }];
    });
  }
}
