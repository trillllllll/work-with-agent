import { describe, expect, it } from 'vitest';
import { parseHash } from './useHashRoute.js';
import { SETTINGS_CATEGORIES } from '../components/settings/settings-categories.js';

const parse = (path: string, query = '') => parseHash(path, new URLSearchParams(query));

describe('parseHash settings routes', () => {
  it('opens settings without a category', () => {
    expect(parse('settings')).toMatchObject({ view: 'settings', settingsCategory: null });
  });

  it('reads every known category', () => {
    for (const category of SETTINGS_CATEGORIES) expect(parse(`settings/${category}`)).toMatchObject({ view: 'settings', settingsCategory: category });
  });

  it('treats an unknown category as plain settings', () => {
    expect(parse('settings/nope')).toMatchObject({ view: 'settings', settingsCategory: null });
  });

  it('only uses the first segment after settings', () => {
    expect(parse('settings/model/extra')).toMatchObject({ view: 'settings', settingsCategory: 'model' });
  });

  it('keeps trash and changes as their own views', () => {
    expect(parse('trash')).toMatchObject({ view: 'trash', settingsCategory: null });
    expect(parse('changes')).toMatchObject({ view: 'changes', settingsCategory: null });
  });

  it('leaves knowledge routes alone', () => {
    expect(parse('knowledge/materials', 'topicId=inbox')).toEqual({ view: 'knowledge', knowledgeSection: 'materials', knowledgeTopicId: '', knowledgeTopicExplicit: true, settingsCategory: null });
  });

  it('falls back to the inbox for unknown views', () => {
    expect(parse('nowhere')).toMatchObject({ view: 'inbox', settingsCategory: null });
  });
});
