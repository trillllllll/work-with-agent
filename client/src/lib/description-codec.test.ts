import { describe, expect, it } from 'vitest';
import {
  parseDescription,
  serializeDescription,
} from './description-codec.js';
import type { JSONContent } from '@tiptap/core';

describe('description codec', () => {
  const sources = [
    '',
    '普通正文\n\n',
    '# 标题\n\n**粗体** 与 *斜体*\n',
    '- [ ] 未完成\n- [x] 已完成\n',
    '```ts\nconst text = \'**不是粗体**\';\n```\n',
    '| 名称 | 值 |\n| :--- | ---: |\n| A | 1 |\n',
    '![示意图](/api/tasks/task-a/images/image-a)\n',
    '[资料甲](wwa-material:material-a)\n',
    'file:///Users/example/a.md\n',
    '中文🙂é\n',
    '<details>\n<summary>旧内容</summary>\n原文\n</details>\n',
  ];

  for (const source of sources) {
    it(`未修改时逐字保留 ${JSON.stringify(source)}`, () => {
      const { model, doc } = parseDescription(source, 'task-a');
      expect(serializeDescription(model, doc)).toBe(source);
    });
  }

  it('加粗段落规范化结果固定', () => {
    const { model } = parseDescription('', 'task-a');
    const doc = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{
          type: 'text',
          text: 'hello',
          marks: [{ type: 'bold' }],
        }],
      }],
    };

    expect(serializeDescription(model, doc)).toBe('**hello**');
  });

  it('修改其他段落后，未知块原文仍然逐字存在', () => {
    const source = '第一段\n\n<details>\n<summary>旧内容</summary>\n原文\n</details>\n';
    const { model, doc } = parseDescription(source, 'task-a');
    const edited: JSONContent = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '改过的段落' }] },
        ...(doc.content ?? []).slice(1),
      ],
    };
    const output = serializeDescription(model, edited);
    expect(output).toContain('<details>\n<summary>旧内容</summary>\n原文\n</details>');
    expect(output).toContain('改过的段落');
    // 结果仍然能按 Markdown 解析回同样的未知块。
    const reparsed = parseDescription(output, 'task-a');
    expect(reparsed.doc.content?.[1]?.type).toBe('rawMarkdown');
  });

  it('代码内部反引号、语言、缩进和空行不丢失', () => {
    const code = 'const a = 1;\n\n```\n内嵌围栏\n```\n    缩进行\n';
    const source = `句子\n\n\`\`\`\`ts\n${code}\`\`\`\`\n`;
    const { model, doc } = parseDescription(source, 'task-a');
    expect(doc.content?.[1]?.type).toBe('codeBlock');
    const edited: JSONContent = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '别的句子' }] },
        ...(doc.content ?? []).slice(1),
      ],
    };
    const output = serializeDescription(model, edited);
    expect(output).toContain('````ts\n');
    const reparsed = parseDescription(output, 'task-a');
    const block = reparsed.doc.content?.find((node) => node.type === 'codeBlock');
    const codeText = (block?.content ?? []).map((child) => child.text ?? '').join('');
    // CommonMark 剥掉闭合围栏前的最后一个换行；内部空行、缩进与反引号逐字保留。
    expect(codeText).toBe(code.replace(/\n$/, ''));
    expect(codeText).toContain('\n\n```');
    expect(codeText).toContain('\n    缩进行');
    expect(block?.attrs?.language).toBe('ts');
  });

  it('有序列表非 1 起始序号不变', () => {
    const source = '3. 甲\n4. 乙\n';
    const { model, doc } = parseDescription(source, 'task-a');
    const edited: JSONContent = {
      type: 'doc',
      content: [
        ...(doc.content ?? []),
        { type: 'paragraph', content: [{ type: 'text', text: '尾注' }] },
      ],
    };
    const output = serializeDescription(model, edited);
    expect(output).toContain('3. 甲\n4. 乙');
    const reparsed = parseDescription(output, 'task-a');
    expect(reparsed.doc.content?.[0]?.attrs?.start).toBe(3);
  });

  it('表格管道符、反斜杠和单元格链接不丢失', () => {
    const source = '| a | b |\n| :--- | --- |\n| [链接](https://example.com/x) | c\\|d |\n';
    const { model, doc } = parseDescription(source, 'task-a');
    const edited: JSONContent = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '前言' }] },
        ...(doc.content ?? []),
      ],
    };
    const output = serializeDescription(model, edited);
    const reparsed = parseDescription(output, 'task-a');
    const table = reparsed.doc.content?.find((node) => node.type === 'table');
    expect(table?.attrs?.alignments).toEqual(['left', null]);
    const lastRow = table?.content?.[1]?.content ?? [];
    const linkNode = lastRow[0]?.content?.[0]?.content?.[0];
    expect(linkNode?.type).toBe('text');
    expect(linkNode?.marks?.[0]?.type).toBe('link');
    expect(linkNode?.marks?.[0]?.attrs?.href).toBe('https://example.com/x');
    const pipeCell = lastRow[1]?.content?.[0]?.content?.[0];
    expect(pipeCell?.text).toBe('c|d');
    expect(output).toContain('c\\|d');
  });

  it('中文、emoji、组合字符前后插入资料引用没有错位', () => {
    const source = '中文🙂é\n';
    const { model, doc } = parseDescription(source, 'task-a');
    const paragraph = doc.content?.[0];
    expect(paragraph?.content).toHaveLength(1);
    const edited: JSONContent = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [
          { type: 'materialReference', attrs: { materialId: 'material-before', label: '前' } },
          ...(paragraph?.content ?? []),
          { type: 'materialReference', attrs: { materialId: 'material-after', label: '后' } },
        ],
      }],
    };
    const output = serializeDescription(model, edited);
    expect(output).toBe('[前](wwa-material:material-before)中文🙂é[后](wwa-material:material-after)');
    const reparsed = parseDescription(output, 'task-a');
    const nodes = reparsed.doc.content?.[0]?.content ?? [];
    expect(nodes[0]?.type).toBe('materialReference');
    expect(nodes[1]?.text).toBe('中文🙂é');
    expect(nodes[2]?.type).toBe('materialReference');
    expect(nodes[2]?.attrs?.materialId).toBe('material-after');
  });

  it('wwa-material: 不被 URL 清洗器删除', () => {
    const source = '';
    const { model } = parseDescription(source, 'task-a');
    const edited: JSONContent = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [
          { type: 'text', text: '引用' },
          { type: 'materialReference', attrs: { materialId: 'mat/érials 1', label: '含特殊字符 [x]' } },
        ],
      }],
    };
    const output = serializeDescription(model, edited);
    expect(output).toContain('wwa-material:');
    const reparsed = parseDescription(output, 'task-a');
    const reference = reparsed.doc.content?.[0]?.content?.[1];
    expect(reference?.attrs?.materialId).toBe('mat/érials 1');
    expect(reference?.attrs?.label).toBe('含特殊字符 [x]');
  });

  it('不合法的跨任务图片地址原样保留在 Markdown 里，由渲染层负责不加载', () => {
    const source = '![越权](/api/tasks/task-b/images/image-a)\n';
    const { model, doc } = parseDescription(source, 'task-a');
    expect(serializeDescription(model, doc)).toBe(source);
    const edited: JSONContent = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '前缀' }] },
        ...(doc.content ?? []),
      ],
    };
    const output = serializeDescription(model, edited);
    expect(output).toContain('/api/tasks/task-b/images/image-a');
  });

  it('空文档规范化为空字符串', () => {
    const { model } = parseDescription('旧内容\n', 'task-a');
    expect(serializeDescription(model, { type: 'doc', content: [] })).toBe('');
  });

  it('标题、列表、勾选项和引用块编辑后按固定规则规范化', () => {
    const { model } = parseDescription('', 'task-a');
    const edited: JSONContent = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '标题' }] },
        { type: 'taskList', content: [
          { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '未完成' }] }] },
          { type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '已完成' }] }] },
        ] },
        { type: 'blockquote', content: [
          { type: 'paragraph', content: [{ type: 'text', text: '引用' }] },
        ] },
        { type: 'paragraph', content: [{ type: 'text', text: '删除线', marks: [{ type: 'strike' }] }] },
      ],
    };
    expect(serializeDescription(model, edited)).toBe('## 标题\n\n- [ ] 未完成\n- [x] 已完成\n\n> 引用\n\n~~删除线~~');
  });

  it('行内代码含有反引号时延长围栏', () => {
    const { model } = parseDescription('', 'task-a');
    const edited: JSONContent = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{ type: 'text', text: 'a ` b', marks: [{ type: 'code' }] }],
      }],
    };
    const output = serializeDescription(model, edited);
    expect(output).toBe('`` a ` b ``');
    const reparsed = parseDescription(output, 'task-a');
    expect(reparsed.doc.content?.[0]?.content?.[0]?.text).toBe('a ` b');
  });

  // 相邻的同符号列表项会被 CommonMark 合并成一个列表，序列化必须交替符号。
  const bulletItem = (text: string): JSONContent => ({
    type: 'listItem',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });
  const taskEntry = (checked: boolean, text: string): JSONContent => ({
    type: 'taskItem',
    attrs: { checked },
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });
  const listOf = (type: string, items: JSONContent[]): JSONContent => ({ type, content: items });
  const docTypes = (markdown: string) => parseDescription(markdown, 'task-a').doc.content?.map((node) => node.type);

  it('相邻无序列表与任务列表换符号，往返后仍是两个列表', () => {
    const { model } = parseDescription('', 'task-a');
    const edited: JSONContent = {
      type: 'doc',
      content: [listOf('bulletList', [bulletItem('甲')]), listOf('taskList', [taskEntry(false, '乙')])],
    };
    const output = serializeDescription(model, edited);
    expect(output).toBe('- 甲\n\n* [ ] 乙');
    expect(docTypes(output)).toEqual(['bulletList', 'taskList']);
  });

  it('任务列表在前、无序列表在后同样换符号', () => {
    const { model } = parseDescription('', 'task-a');
    const edited: JSONContent = {
      type: 'doc',
      content: [listOf('taskList', [taskEntry(true, '甲')]), listOf('bulletList', [bulletItem('乙')])],
    };
    const output = serializeDescription(model, edited);
    expect(output).toBe('- [x] 甲\n\n* 乙');
    expect(docTypes(output)).toEqual(['taskList', 'bulletList']);
  });

  it('多个列表连排时符号交替，边界全部保留', () => {
    const { model } = parseDescription('', 'task-a');
    const edited: JSONContent = {
      type: 'doc',
      content: [
        listOf('bulletList', [bulletItem('甲')]),
        listOf('bulletList', [bulletItem('乙')]),
        listOf('taskList', [taskEntry(false, '丙')]),
        listOf('taskList', [taskEntry(true, '丁')]),
      ],
    };
    const output = serializeDescription(model, edited);
    expect(output).toBe('- 甲\n\n* 乙\n\n- [ ] 丙\n\n* [x] 丁');
    expect(docTypes(output)).toEqual(['bulletList', 'bulletList', 'taskList', 'taskList']);
  });

  it('被段落隔开的列表不换符号，输出与旧版一致', () => {
    const { model } = parseDescription('', 'task-a');
    const edited: JSONContent = {
      type: 'doc',
      content: [
        listOf('bulletList', [bulletItem('甲')]),
        { type: 'paragraph', content: [{ type: 'text', text: '间隔' }] },
        listOf('bulletList', [bulletItem('乙')]),
        { type: 'orderedList', attrs: { start: 1 }, content: [bulletItem('丙')] },
        listOf('taskList', [taskEntry(false, '丁')]),
      ],
    };
    const output = serializeDescription(model, edited);
    expect(output).toBe('- 甲\n\n间隔\n\n- 乙\n\n1. 丙\n\n- [ ] 丁');
    expect(docTypes(output)).toEqual(['bulletList', 'paragraph', 'bulletList', 'orderedList', 'taskList']);
  });

  it('引用块内相邻列表同样换符号', () => {
    const { model } = parseDescription('', 'task-a');
    const edited: JSONContent = {
      type: 'doc',
      content: [{
        type: 'blockquote',
        content: [listOf('bulletList', [bulletItem('甲')]), listOf('taskList', [taskEntry(false, '乙')])],
      }],
    };
    const output = serializeDescription(model, edited);
    expect(output).toBe('> - 甲\n>\n> * [ ] 乙');
    const reparsed = parseDescription(output, 'task-a');
    const quote = reparsed.doc.content?.[0];
    expect(quote?.type).toBe('blockquote');
    expect(quote?.content?.map((node) => node.type)).toEqual(['bulletList', 'taskList']);
  });

  it('同一个列表项内相邻的嵌套列表换符号，往返不产生原文片段', () => {
    const { model } = parseDescription('', 'task-a');
    const edited: JSONContent = {
      type: 'doc',
      content: [listOf('bulletList', [{
        type: 'listItem',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: '父项' }] },
          listOf('bulletList', [bulletItem('甲')]),
          listOf('taskList', [taskEntry(false, '乙')]),
        ],
      }])],
    };
    const output = serializeDescription(model, edited);
    expect(output).toBe('- 父项\n  - 甲\n  * [ ] 乙');
    const reparsed = parseDescription(output, 'task-a');
    expect(reparsed.doc.content?.[0]?.type).toBe('bulletList');
    const nested = reparsed.doc.content?.[0]?.content?.[0]?.content?.slice(1);
    expect(nested?.map((node) => node.type)).toEqual(['bulletList', 'taskList']);
  });

  it('混合列表来源仍整体保留为原文片段（解析端行为不变）', () => {
    const source = '- 甲\n\n- [ ] 乙\n';
    const { doc } = parseDescription(source, 'task-a');
    expect(doc.content?.map((node) => node.type)).toEqual(['rawMarkdown']);
  });
});
