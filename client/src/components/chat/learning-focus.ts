import type { ChatAttachment } from '@/lib/assistant-context.js';
import type { ChatMessage } from '../../chat.js';

/** The knowledge point the conversation is currently about: the latest node card or explicitly attached note. */
export function focusedLearningNode(messages: ChatMessage[], attachments: ChatAttachment[] = []) {
  const pending = [...attachments].reverse().find(item => item.learningNodeId)?.learningNodeId;
  if (pending) return pending;
  for (const message of [...messages].reverse()) {
    const card = [...(message.parts ?? [])].reverse().find(part => part.type === 'learning_card' && part.kind === 'node');
    if (card && card.type === 'learning_card' && card.nodeId) return card.nodeId;
    if (message.role === 'user' && message.context?.schemaVersion === 3) {
      const attached = [...message.context.attachments].reverse().find(item => item.learningNodeId)?.learningNodeId;
      if (attached) return attached;
    }
  }
  return undefined;
}
