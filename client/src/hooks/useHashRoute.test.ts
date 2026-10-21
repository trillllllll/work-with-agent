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
    expect(parse('knowledge/materials', 'topicId=inbox')).toEqual({ view: 'knowledge', knowledgeSection: 'materials', knowledgeTopicId: '', knowledgeTopicExplicit: true, settingsCategory: null, query: { topicId: 'inbox' } });
  });

  it('keeps the runs view when the hash carries a tab query', () => {
    expect(parse('runs', 'tab=handoffs')).toEqual({ view: 'runs', knowledgeSection: null, knowledgeTopicId: null, knowledgeTopicExplicit: false, settingsCategory: null, query: { tab: 'handoffs' } });
    expect(parse('runs', 'tab=orchestrations')).toMatchObject({ view: 'runs', query: { tab: 'orchestrations' } });
    expect(parse('runs')).toMatchObject({ view: 'runs', query: {} });
  });

  it('keeps the stats view and its range query', () => {
    expect(parse('stats', 'range=7d&from=2026-10-01&to=2026-10-07')).toEqual({ view: 'stats', knowledgeSection: null, knowledgeTopicId: null, knowledgeTopicExplicit: false, settingsCategory: null, query: { range: '7d', from: '2026-10-01', to: '2026-10-07' } });
  });

  it('falls back to the inbox for unknown views', () => {
    expect(parse('nowhere')).toMatchObject({ view: 'inbox', settingsCategory: null });
  });
});
