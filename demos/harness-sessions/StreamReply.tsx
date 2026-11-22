import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import { HarnessTimeline } from '@/components/workspace/HarnessTimeline.js';
import type { HarnessTool, HarnessTurn, HarnessView } from '../../server/src/node-agent/harness-protocol.js';
import type { HarnessId, StreamMessage } from './fixtures.js';
import { streamView } from './stream.js';

const diagram = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 130" role="img" aria-label="手机通过服务器中继接回 Mac 上的原会话">
  <rect width="560" height="130" rx="18" fill="#f2f5f4"/>
  <path d="M161 65h40m-7-6 7 6-7 6m166-6h40m-7-6 7 6-7 6" fill="none" stroke="#607a77" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <g fill="#fff" stroke="#b0c4be"><rect x="21" y="38" width="135" height="54" rx="12"/><rect x="212" y="38" width="135" height="54" rx="12"/><rect x="404" y="38" width="135" height="54" rx="12"/></g>
  <g fill="#203633" font-family="sans-serif" font-size="17" text-anchor="middle">
    <text x="88" y="71">手机网页</text><text x="280" y="71">服务器中继</text><text x="471" y="71">Mac 执行器</text>
  </g>
</svg>`;

export function StreamReply({ message, harness, name, now, replay }: {
  message: StreamMessage; harness: HarnessId; name: string; now: number; replay?: () => void;
}) {
  const frame = streamView(message, harness, now);
  const turnId = message.id;
  const status: HarnessTurn['status'] = frame.complete ? 'completed' : message.stoppedAt === undefined ? 'inProgress' : 'interrupted';
  const live = status === 'inProgress';
  const replyId = `${turnId}-answer`;
  const includesDiagram = status === 'completed' && message.script === 'checks';
  const introId = `${turnId}-intro`;
  const view: HarnessView = { turn: { id: turnId, status }, messages: [], tools: [], approvals: [], error: null };
  const toolStatus = (state: 'running' | 'done'): HarnessTool['status'] => state === 'done' ? 'completed' : live ? 'running' : 'interrupted';
  if (frame.intro) view.messages.push({ id: introId, turnId, order: 1, role: 'assistant', phase: 'commentary', text: frame.intro, streaming: !frame.read });
  if (frame.read) view.tools?.push({
    id: `${turnId}-read`, turnId, order: 2, kind: 'command', status: toolStatus(frame.read), title: 'rg -n HarnessTimeline client/src/components/workspace',
  });
  if (frame.test) view.tools?.push({
    id: `${turnId}-test`, turnId, order: 3, kind: 'command', status: toolStatus(frame.test), title: 'npm test -- mobile-sessions',
    output: frame.output, exitCode: frame.test === 'done' ? 0 : undefined,
  });
  if (frame.answer) view.messages.push({ id: replyId, turnId, order: 4, role: 'assistant', phase: 'final_answer',
    text: frame.answer + (includesDiagram ? '\n\n附上[手机会话流程图](./mobile-session.svg)。' : '') });
  if (includesDiagram) view.artifacts = [{ id: `${turnId}-diagram`, turnId, messageId: replyId, kind: 'svg',
    name: '手机会话流程图.svg', href: './mobile-session.svg', source: diagram }];

  return <li className="min-w-0" aria-busy={live}>
    <HarnessTimeline view={view} name={name} liveMessageId={live ? (frame.answer ? replyId : introId) : undefined} />
    {!live && replay && <Button type="button" variant="chip" size="bare" className="harness-replay" onClick={replay}>
      <RotateCcw className="size-3.5" aria-hidden="true" />重播演示
    </Button>}
  </li>;
}
