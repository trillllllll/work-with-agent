import { describe, expect, it } from 'vitest';
import { focusedLearningNode } from './learning-focus.js';
import { isFigureShortcut } from './study-shortcuts.js';
import { applyMessageEvent, parseExternalParts, type LearningCardPart } from '../../chat.js';

const card: LearningCardPart = { schemaVersion: 1, type: 'learning_card', id: 'card', kind: 'node', mapId: 'map', nodeId: 'node', title: 'Node' };
describe('learning chat interactions', () => {
  it('restores and deduplicates live cards and finds the latest focused knowledge point', () => {
    const event = { type: 'external_prompt', messageId: 'message', part: card };
    const messages = applyMessageEvent(applyMessageEvent([{ id: 'message', role: 'assistant', content: '' }], event), event);
    expect(messages[0].parts).toEqual([card]);
    expect(parseExternalParts(JSON.stringify([card]))).toEqual([card]);
    expect(focusedLearningNode(messages)).toBe('node');
    expect(parseExternalParts(JSON.stringify([{ ...card, kind: 'node', nodeId: undefined }]))).toEqual([]);
  });
  it('opens M only outside inputs, composition and modifier shortcuts', () => {
    expect(isFigureShortcut({ key: 'm' })).toBe(true);
    for (const extra of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { isComposing: true }, { repeat: true }, { target: { isContentEditable: true } as unknown as EventTarget }, { target: { closest: () => ({}) } as unknown as EventTarget }]) expect(isFigureShortcut({ key: 'm', ...extra })).toBe(false);
  });
});
