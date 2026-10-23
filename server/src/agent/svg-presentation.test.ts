import { describe, expect, it } from 'vitest';
import { builtinSystemPrompt, builtinToolDefinitions } from './capabilities.js';
import { presentReplySchema, validateReplyBlock } from './content-blocks.js';

describe('SVG presentation guidance', () => {
  it('gives the model a valid standalone SVG block example instead of a Markdown fence', async () => {
    const prompt = builtinSystemPrompt();
    const example = prompt.match(/示例参数：(.*?)。SVG/s)?.[1];
    expect(example).toBeTruthy();
    const reply = presentReplySchema.parse(JSON.parse(example!));
    const svg = reply.blocks.find((block) => block.type === 'svg')!;
    expect(await validateReplyBlock(svg, async () => [])).toMatchObject({ type: 'svg', source: expect.stringContaining('<svg') });
    expect(prompt).toContain('不能把 SVG 包在 Markdown 代码围栏里');
    expect(builtinToolDefinitions().find((tool) => tool.function.name === 'present_reply')?.function.description).toContain('独立的');
  });
});
