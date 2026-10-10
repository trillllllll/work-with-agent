import { describe, expect, it } from 'vitest';
import { quadrantForPriority } from './quadrant.js';

describe('priority quadrants', () => {
  it('maps all existing priority values to the standard matrix', () => {
    expect(quadrantForPriority('high')).toMatchObject({ title: '重要且紧急', description: '立即处理' });
    expect(quadrantForPriority('medium')).toMatchObject({ title: '重要但不紧急', description: '计划安排' });
    expect(quadrantForPriority('low')).toMatchObject({ title: '不重要但紧急', description: '快速处理或委派' });
    expect(quadrantForPriority('none')).toMatchObject({ title: '不重要且不紧急', description: '减少或删除' });
  });
});
