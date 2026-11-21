import type { HarnessId, StreamMessage } from './fixtures.js';

type ToolState = 'running' | 'done';
type Frame =
  | { at: number; part: 'intro' | 'output' | 'answer'; delta: string }
  | { at: number; part: 'read' | 'test'; state: ToolState }
  | { at: number; part: 'end' };

// These are simulated arrivals from a computer. A refresh can reconstruct the same turn up to its last received frame.
const checks: Frame[] = [
  { at: 450, part: 'intro', delta: '我先打开会话页的实现，' },
  { at: 970, part: 'intro', delta: '再跑一遍手机上的三个交互。' },
  { at: 1_600, part: 'read', state: 'running' },
  { at: 2_750, part: 'read', state: 'done' },
  { at: 3_100, part: 'test', state: 'running' },
  { at: 3_800, part: 'output', delta: '启动手机浏览器…\n' },
  { at: 4_900, part: 'output', delta: '✓ 选择项目后显示对应会话\n' },
  { at: 6_000, part: 'output', delta: '✓ 上滑阅读时保持当前位置\n' },
  { at: 7_150, part: 'output', delta: '✓ 刷新后接回同一条对话\n' },
  { at: 7_900, part: 'test', state: 'done' },
  { at: 8_250, part: 'answer', delta: '**3 项检查已通过。**' },
  { at: 8_850, part: 'answer', delta: ' 选项目、上滑阅读和刷新恢复都按预期工作。' },
  { at: 9_500, part: 'answer', delta: '\n\n打开原来的对话，' },
  { at: 10_050, part: 'answer', delta: '可以接着上次的位置继续聊。' },
  { at: 10_650, part: 'end' },
];

const replies: Record<HarnessId, string[]> = {
  codex: ['收到。', '我会沿着这条会话', '检查项目选择和消息显示。', '\n\n先看手机列表，', '再看打开聊天后的滚动位置。', '结果会留在同一条对话里。'],
  claude: ['收到。', '我先看当前页面的结构，', '再核对有哪些组件可以复用。', '\n\n切换会话时，', '每条对话都应该保留自己的历史和草稿。'],
  zcode: ['收到。', '我会按发生顺序', '查看这一轮的消息和工具输出。', '\n\n需要额外权限时，', '会在当前对话中等待确认。'],
};

function replyFrames(chunks: string[]): Frame[] {
  const frames: Frame[] = chunks.map((delta, i) => ({ at: 380 + i * 510, part: 'answer', delta }));
  return [...frames, { at: 380 + chunks.length * 510, part: 'end' }];
}
const framesByHarness = { codex: replyFrames(replies.codex), claude: replyFrames(replies.claude), zcode: replyFrames(replies.zcode) };

export function nextFrameAt(message: StreamMessage, harness: HarnessId, now: number) {
  const start = message.startedAt;
  if (start === null || message.stoppedAt !== undefined) return undefined;
  const frames = message.script === 'checks' ? checks : framesByHarness[harness];
  const next = frames.find((frame) => start + frame.at > now);
  return next && start + next.at;
}

export function streamView(message: StreamMessage, harness: HarnessId, now: number) {
  const elapsed = message.startedAt === null ? -1 : (message.stoppedAt ?? now) - message.startedAt;
  const view: { intro: string; output: string; answer: string; read?: ToolState; test?: ToolState; complete: boolean } =
    { intro: '', output: '', answer: '', complete: false };
  for (const frame of message.script === 'checks' ? checks : framesByHarness[harness]) {
    if (frame.at > elapsed) break;
    if ('delta' in frame) view[frame.part] += frame.delta;
    else if ('state' in frame) view[frame.part] = frame.state;
    else view.complete = true;
  }
  return view;
}
