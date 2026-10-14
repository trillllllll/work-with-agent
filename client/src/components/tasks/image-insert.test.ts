import { Schema } from '@tiptap/pm/model';
import { describe, expect, it } from 'vitest';
import { imageInsertAt, taskImageContent } from './description-extensions.js';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    text: { group: 'inline' },
    paragraph: { content: 'inline*', group: 'block' },
    codeBlock: { content: 'text*', group: 'block', code: true, marks: '' },
    image: { group: 'inline', inline: true, attrs: { src: { default: '' }, alt: { default: '' } } },
  },
});

describe('图片插入位置', () => {
  const text = 'const n = 1;';
  const code = schema.node('codeBlock', null, [schema.text(text)]);
  const doc = schema.node('doc', null, [code]);

  it('代码块内部的位置改到代码块之后', () => {
    expect(imageInsertAt(doc, 1)).toBe(code.nodeSize);
    expect(imageInsertAt(doc, 1 + text.length)).toBe(code.nodeSize);
  });

  it('代码块外的位置保持不变', () => {
    expect(imageInsertAt(doc, 0)).toBe(0);
    const paragraph = schema.node('paragraph', null, [schema.text('后')]);
    const withParagraph = schema.node('doc', null, [code, paragraph]);
    const after = code.nodeSize + 1;
    expect(imageInsertAt(withParagraph, after)).toBe(after);
  });

  it('插在代码块后时包成段落，插在段落里时保持行内', () => {
    const afterCode = taskImageContent(doc, 1, '/api/tasks/a/images/b', schema.nodes.image);
    expect(afterCode.at).toBe(code.nodeSize);
    expect(afterCode.content.type).toBe('paragraph');
    const paragraph = schema.node('paragraph', null, [schema.text('后')]);
    const withParagraph = schema.node('doc', null, [code, paragraph]);
    const inside = taskImageContent(withParagraph, code.nodeSize + 1, '/img', schema.nodes.image);
    expect(inside.at).toBe(code.nodeSize + 1);
    expect(inside.content.type).toBe('image');
  });
});
