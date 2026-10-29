import { describe, expect, it } from 'vitest';
import { chatAttachment } from '../domain/chat-context.js';
import { initialToolGroups, lazySystemPrompt, mediaInstructionsFor } from './tool-loading.js';
import { commandForLearning, validateLearningArguments } from '../application/agent-learning.js';
import { isIndependentLearningWrite } from '../application/workspace-relay.js';

describe('study workflow contract', () => {
  it('limits chat practice proposals to generation configuration', () => {
    const args = { action: 'practice_generate', mapId: 'map', nodeIds: ['node'], count: 5, difficulty: 'easy', types: ['single'] };
    expect(validateLearningArguments(args)).toBeNull();
    expect(commandForLearning('practice_generate', args)).toMatchObject({ kind: 'learning.practice.request', input: { mapId: 'map', count: 5 } });
    for (const field of ['answer', 'rubric', 'score', 'ownerId', 'activeAttemptId']) expect(validateLearningArguments({ ...args, [field]: 'forged' })).toContain('未知参数');
    expect(validateLearningArguments({ ...args, count: 100 })).not.toBeNull();
    expect(validateLearningArguments({ ...args, action: 'attempt_submit' })).toBe('未知动作');
  });

  it('only exempts exact learning POST endpoints from task outbox waits', () => {
    for (const path of ['practice/generate', 'practice/start', 'practice/items/i/draft', 'practice/items/i/submit', 'practice/items/i/retry', 'practice/items/i/events', 'practice/sessions/s/update', 'practice/attempts/a/regrade', 'reviews/update', 'jobs/j/retry', 'jobs/j/cancel', 'resume']) {
      expect(isIndependentLearningWrite('POST', `/api/v1/learning/${path}`), path).toBe(true);
      expect(isIndependentLearningWrite('PUT', `/api/v1/learning/${path}`), path).toBe(false);
    }
    for (const path of ['/api/v1/commands', '/api/chat', '/api/v1/learning/maps', '/api/v1/learning/practice/items/i/delete', '/api/v1/learning/practice/items/i%2Fcommands/submit', '/api/v1/learning-other/practice/generate', '/api/v1/learning/resume/']) expect(isIndependentLearningWrite('POST', path), path).toBe(false);
  });
  it('retains teaching and persistence boundaries when media is lazy loaded', () => {
    const prompt = lazySystemPrompt('study');
    expect(prompt).toContain('【连续学习与练习】');
    expect(prompt).toContain('用户原生提交答案由应用保存');
    expect(prompt).toContain('待判题、跳过与判题失败不等于答错');
    expect(prompt).toContain('尊重用户手动延期和暂停');
    expect(mediaInstructionsFor('study')).not.toContain('【连续学习与练习】');
    expect(lazySystemPrompt('work')).not.toContain('【连续学习与练习】');
  });

  it('loads the learning write group for explicit requests to create persistent exercises', () => {
    for (const request of ['出题', '做题', '刷题', '开始复习', 'practice', 'quiz']) {
      expect(initialToolGroups(request, 'learning', 'study')).toContain('learning_write');
    }
    expect(initialToolGroups('解释闭包', 'learning', 'study')).not.toContain('learning_write');
    expect(initialToolGroups('出题', 'learning', 'work')).not.toContain('learning_write');
  });

  it('keeps complete practice references and rejects partial or extra authority fields', () => {
    const base = { id: 'ref', kind: 'draft', title: '第 3 题', text: '我的未提交答案', unsaved: true };
    expect(chatAttachment.safeParse(base).success).toBe(true);
    expect(chatAttachment.safeParse({ ...base, learningItemId: 'item' }).success).toBe(false);
    const practice = { ...base, learningSessionId: 'session', learningItemId: 'item', learningAttemptId: 'attempt', learningIntent: 'hint' };
    expect(chatAttachment.parse(practice)).toEqual(practice);
    expect(chatAttachment.safeParse({ ...practice, score: 100 }).success).toBe(false);
  });
});
