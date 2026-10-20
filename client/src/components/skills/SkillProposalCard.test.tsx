import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AppReviewEntity } from '../../../../server/src/domain/task-batch-types.js';
import { SkillProposalDetails } from './SkillProposalCard.js';

const description = '需要把任务起止时间画成时间轴条带时使用。用 present_reply 的 html 块绘制单文件甘特图。含数据格式、百分比布局规则和可复用色值。';
const instructions = [
  '以分钟为统一单位。',
  '',
  '| 方式 | 结果 |',
  '| --- | --- |',
  '| mermaid gantt | 客户端不渲染 gantt 语法 |',
  '| svg 块 | 属性白名单未知且查不到 |',
  '',
  '```js',
  'var D = [{n:"任务名", s:26, e:53}];',
  '```',
].join('\n');

function entity(): AppReviewEntity {
  return {
    entityType: 'skill',
    entityId: 'skill-1',
    titleBefore: null,
    titleAfter: '甘特图（HTML 块）',
    operation: 'create',
    origin: 'explicit',
    revisionBefore: null,
    revisionAfter: 1,
    fields: [
      { key: 'description', label: '描述', before: null, after: description, beforeText: '', afterText: description },
      { key: 'enabled', label: '启用', before: null, after: true, beforeText: '', afterText: '启用' },
      { key: 'instructions', label: '正文', before: null, after: instructions, beforeText: '', afterText: instructions },
    ],
  };
}

describe('skill proposal preview layout', () => {
  it('keeps the description and markdown body inside the card width', () => {
    const html = renderToStaticMarkup(<SkillProposalDetails entity={entity()} />);
    expect(html).toContain('data-testid="skill-proposal"');
    expect(html).toContain(`<span class="min-w-0 [overflow-wrap:anywhere]">${description}</span>`);
    expect(html).toContain('data-testid="skill-proposal-body"');
    expect(html).toContain('max-h-56 min-w-0 max-w-full overflow-hidden');
    const bodyAt = html.indexOf('data-testid="skill-proposal-body"');
    const firstParagraph = html.indexOf('<p');
    expect(firstParagraph).toBeGreaterThan(bodyAt);
    expect(html.slice(firstParagraph)).toMatch(/^<p class="my-1\.5">/);
    expect(html).toContain('<td class="border-b px-2 py-1.5 align-top [overflow-wrap:anywhere]">属性白名单未知且查不到</td>');
    expect(html).toContain('max-w-full overflow-x-auto');
  });
});
