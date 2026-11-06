import { mermaidHasContent } from '../shared/mermaid-policy.js';
import { it, expect } from 'vitest';
import { sourcePreviewAvailable } from './source-preview.js';
it('does not count empty/incomplete prefixes or style/defs as delivered help', () => {
  for (const [type, source] of [['svg', '<svg'], ['svg', '<svg><defs><linearGradient id="a"/></defs>'], ['html', '<style>p{color:red}</style>'], ['html', '<section><p>unfinished'], ['mermaid', 'flowchart LR\nA[unfinished\n']]) expect(sourcePreviewAvailable(type, source)).toBe(false);
  expect(sourcePreviewAvailable('svg', '<svg><rect width="4"/>')).toBe(true);
  expect(sourcePreviewAvailable('html', '<section><p>ready</p></section>')).toBe(true);
});

it('does not acknowledge a Mermaid declaration or comments without diagram content', () => {
  for (const source of ['flowchart LR\n', 'graph TD;\n%% a comment\n', 'sequenceDiagram\n', 'stateDiagram-v2\n', 'classDiagram\n']) expect(mermaidHasContent(source)).toBe(false);
  expect(mermaidHasContent('flowchart LR; A-->B')).toBe(true);
});
