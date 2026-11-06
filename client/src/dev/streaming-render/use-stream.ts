// i18n-ignore-file: isolated experiment controls.
import { useEffect, useRef, useState } from 'react';
import { ExperimentalReplyParser } from './parser.js';
import { fixture, type Kind } from './fixtures.js';

export type StreamState = { source: string; categories: string[]; values: number[]; received: number; chunks: number; events: number; done: boolean; error: string; interrupted: boolean };
const empty = (): StreamState => ({ source: '', categories: [], values: [], received: 0, chunks: 0, events: 0, done: false, error: '', interrupted: false });
export function useStream(kind: Kind, invalid: boolean) {
  const [payload] = useState(() => fixture(kind, invalid));
  const [bytes] = useState(() => new TextEncoder().encode(payload.wire));
  const parser = useRef(new ExperimentalReplyParser());
  const current = useRef(empty());
  const [state, setState] = useState(current.current);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(0.5);
  const [chunkSize, setChunkSize] = useState(32);
  const startedAt = useRef(0);
  const stopped = state.done || Boolean(state.error) || state.interrupted;
  function advance() {
    const before = current.current;
    if (before.done || before.error || before.interrupted) return;
    if (!startedAt.current) startedAt.current = performance.now();
    const end = Math.min(bytes.length, before.received + chunkSize);
    const next = { ...before, received: end, chunks: before.chunks + 1 };
    try {
      parser.current.write(bytes.slice(before.received, end));
      const events = parser.current.drain(); next.events += events.length;
      for (const event of events) {
        if (event.kind === 'text') next.source = event.text;
        if (event.kind === 'source') next.source = event.source;
        if (event.kind === 'chart') { next.categories = event.categories; next.values = event.values; next.source = JSON.stringify({ categories: event.categories, values: event.values }, null, 2); }
      }
      if (end === bytes.length) { parser.current.finish(); next.done = true; setPlaying(false); }
    } catch (error) { next.error = error instanceof Error ? error.message : '解析失败'; setPlaying(false); }
    current.current = next; setState(next);
  }
  const tick = useRef(advance); tick.current = advance;
  useEffect(() => {
    if (!playing || stopped) return;
    const timer = window.setInterval(() => tick.current(), 70 / speed);
    return () => clearInterval(timer);
  }, [playing, speed, stopped]);
  function interrupt() {
    setPlaying(false); current.current = { ...current.current, interrupted: true }; setState(current.current);
  }
  return { state, playing, setPlaying, speed, setSpeed, chunkSize, setChunkSize, advance, interrupt, startedAt, total: bytes.length, stopped, wire: payload.wire };
}
