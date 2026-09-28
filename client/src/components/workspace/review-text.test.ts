import { describe, expect, it } from 'vitest';
import { reviewPreview } from './review-text.js';

describe('review preview', () => {
  it('keeps a short result intact', () => {
    expect(reviewPreview('一行说明')).toEqual({ long: false, preview: '一行说明' });
  });

  it('counts 200 characters and keeps only that prefix', () => {
    const text = `${'字'.repeat(200)}后续`;
    expect(reviewPreview(text)).toEqual({ long: true, preview: '字'.repeat(200) });
  });
});
