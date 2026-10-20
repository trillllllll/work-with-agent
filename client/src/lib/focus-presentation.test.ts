import { describe, expect, it } from 'vitest';
import { focusOriginFromNavigation, hashRouteHead } from './focus-presentation.js';

describe('focusOriginFromNavigation', () => {
  it('reads the route head, including knowledge sections', () => {
    expect(hashRouteHead('#/plan')).toBe('plan');
    expect(hashRouteHead('#/knowledge/materials?topicId=inbox')).toBe('knowledge');
    expect(hashRouteHead('')).toBe('');
    expect(hashRouteHead('#/')).toBe('');
  });

  it('records a normal page so shrink can return', () => {
    expect(focusOriginFromNavigation('#/plan')).toEqual({ hash: '#/plan' });
    expect(focusOriginFromNavigation('#/knowledge/materials?topicId=inbox')).toEqual({ hash: '#/knowledge/materials?topicId=inbox' });
    expect(focusOriginFromNavigation('')).toEqual({ hash: '#/inbox' });
    expect(focusOriginFromNavigation('#/')).toEqual({ hash: '#/' });
  });

  it('does not record focus, chat, or a workspace modal', () => {
    for (const hash of ['#/focus', '#/chat', '#/settings', '#/trash', '#/changes']) {
      expect(focusOriginFromNavigation(hash)).toBeNull();
    }
  });
});
