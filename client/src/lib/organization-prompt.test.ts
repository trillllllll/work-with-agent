import { describe, expect, it } from 'vitest';
import { organizationMcpPrompt } from './organization-prompt.js';

describe('organization MCP prompt', () => {
  it('names the request, both tools, and tells the model not to confirm', () => {
    const prompt = organizationMcpPrompt({ id: 'org-1', purpose: '整理下一步' });
    expect(prompt).toContain('org-1');
    expect(prompt).toContain('整理下一步');
    expect(prompt).toContain('get_organization_request');
    expect(prompt).toContain('submit_organization_result');
    expect(prompt).toContain('不要确认');
  });
});
