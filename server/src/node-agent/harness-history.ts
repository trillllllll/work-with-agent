import { asObject } from './harness-codex.js';
import { readHarnessArtifacts } from './harness-artifacts.js';
import { codexHarnessTool } from './harness-tools.js';
import {
  HARNESS_ARTIFACTS, HARNESS_MESSAGES, HARNESS_TEXT_LIMIT, HARNESS_TOOLS, harnessMessagePhase,
  type HarnessArtifact, type HarnessMessage, type HarnessTool, type HarnessTurn, type HarnessView,
} from './harness-protocol.js';

export const codexText = (value: unknown) => typeof value === 'string' ? value : '';
export const codexItems = (value: unknown) => Array.isArray(value) ? value.map(asObject) : [];

export function codexMessage(item: Record<string, unknown>, turnId: string, streaming = false): HarnessMessage | null {
  const id = codexText(item.id);
  if (!id || !turnId) return null;
  if (item.type === 'agentMessage') {
    const phase = harnessMessagePhase.safeParse(item.phase);
    return { id, turnId, role: 'assistant', text: codexText(item.text).slice(0, HARNESS_TEXT_LIMIT), streaming,
      ...(phase.success ? { phase: phase.data } : {}) };
  }
  if (item.type === 'userMessage') {
    const text = codexItems(item.content).filter((part) => part.type === 'text').map((part) => codexText(part.text)).join('\n');
    return { id, turnId, role: 'user', text: text.slice(0, HARNESS_TEXT_LIMIT) };
  }
  return null;
}

export function codexTurn(value: Record<string, unknown>): HarnessTurn | null {
  const id = codexText(value.id);
  if (!id) return null;
  const status = value.status;
  if (status === 'inProgress' || status === 'completed' || status === 'interrupted') return { id, status };
  if (status === 'failed') return { id, status, error: 'Codex 当前轮执行失败' };
  return { id, status: 'unknown' };
}

/** A live snapshot fits the event window; a history page keeps all of its message rows. */
export async function projectCodexHistory(data: unknown, cwd: string, roots: string[], liveSnapshot: boolean) {
  const messages: HarnessMessage[] = [];
  const tools: HarnessTool[] = [];
  const turns: HarnessTurn[] = [];
  const clients = new Set<string>();
  const artifactMessages: HarnessMessage[] = [];
  let order = 0;
  for (const entry of codexItems(data).reverse()) {
    const raw = codexTurn(entry);
    if (!raw) continue;
    const turn: HarnessTurn = liveSnapshot && raw.status === 'inProgress' ? { ...raw, status: 'unknown' } : raw;
    turns.push(turn);
    let answer: HarnessMessage | undefined;
    for (const item of codexItems(entry.items)) {
      if (item.type === 'userMessage' && typeof item.clientId === 'string') clients.add(item.clientId);
      const message = codexMessage(item, turn.id);
      if (message) {
        messages.push({ ...message, order: ++order });
        if (message.role === 'assistant' && message.phase !== 'commentary') answer = message;
      }
      const tool = codexHarnessTool(item, turn.id, true);
      if (tool) tools.push({ ...tool, order: ++order, status: tool.status !== 'running' || turn.status === 'inProgress'
        ? tool.status : turn.status === 'interrupted' ? 'interrupted' : 'unknown' });
    }
    if (answer?.text && raw.status !== 'inProgress') artifactMessages.push(answer);
  }
  const visible = liveSnapshot ? messages.slice(-HARNESS_MESSAGES) : messages;
  const visibleIds = new Set(visible.map((item) => item.id));
  const artifacts: HarnessArtifact[] = [];
  for (const answer of artifactMessages.reverse()) {
    if (!visibleIds.has(answer.id)) continue;
    const found = await readHarnessArtifacts(answer, cwd, roots);
    artifacts.unshift(...found.slice(0, HARNESS_ARTIFACTS - artifacts.length));
    if (artifacts.length === HARNESS_ARTIFACTS) break;
  }
  const view: HarnessView = { messages: visible, tools: tools.slice(-HARNESS_TOOLS), turns, artifacts,
    turn: liveSnapshot ? turns.at(-1) ?? null : null, approvals: [], error: null };
  return { view, clients };
}
