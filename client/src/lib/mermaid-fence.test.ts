import { describe, expect, it } from 'vitest';
import { isMermaidFence, mermaidSource } from './mermaid-fence.js';

describe('mermaid fences', () => {
  it('hands only mermaid fences to the renderer', () => {
    expect(isMermaidFence('language-mermaid')).toBe(true);
    expect(isMermaidFence('hljs language-mermaid')).toBe(true);
    expect(isMermaidFence('language-ts')).toBe(false);
    expect(isMermaidFence('language-mermaid-extra')).toBe(false);
    expect(isMermaidFence(undefined)).toBe(false);
    expect(isMermaidFence(null)).toBe(false);
  });

  it('drops the trailing newline markdown adds to a fence', () => {
    expect(mermaidSource('flowchart TD\n  A --> B\n')).toBe('flowchart TD\n  A --> B');
    expect(mermaidSource('gantt')).toBe('gantt');
  });
});
