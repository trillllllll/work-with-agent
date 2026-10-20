import { describe, expect, it } from 'vitest';
import { authHeaders, availableTaskStatuses } from './api.js';
import i18n from '../i18n/index.js';

describe('task status options', () => {
  it('keeps the current status and exposes only allowed targets', () => {
    expect(availableTaskStatuses({ status: 'todo', allowedTransitions: ['doing'] })).toEqual(['todo', 'doing']);
    expect(availableTaskStatuses({ status: 'done', allowedTransitions: ['doing'] })).toEqual(['doing', 'done']);
  });
});

describe('request headers', () => {
  it('send the chosen UI language so server messages match it', async () => {
    expect(authHeaders()['X-WWA-Language']).toBe('zh-CN');
    await i18n.changeLanguage('en');
    expect(authHeaders()['X-WWA-Language']).toBe('en');
    await i18n.changeLanguage('zh-CN');
  });
});
