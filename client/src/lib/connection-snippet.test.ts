import { describe, expect, it } from 'vitest';
import { checkSnippet, quotePowerShell, setupSnippet, type ConnectionConfiguration } from './connection-snippet.js';

const paste = '<paste the credential returned once at creation>';
const placeholder = '填入创建时保存的凭据';
const token = 'secret-token';
const config: ConnectionConfiguration = {
  command: '/usr/bin/node',
  args: ['src/mcp/index.js', '--flag'],
  url: 'http://127.0.0.1:3015/mcp',
  env: { WWA_API_URL: 'http://127.0.0.1:3015', WWA_CONNECTION_TOKEN: paste },
};

describe('connection snippets', () => {
  it('builds a Claude setup command that contains the real token', () => {
    const snippet = setupSnippet('claude', config, token);
    expect(snippet).toBe("claude mcp add work_with_agent '/usr/bin/node' 'src/mcp/index.js' '--flag' --scope user --env 'WWA_API_URL=http://127.0.0.1:3015' 'WWA_CONNECTION_TOKEN=secret-token'");
    expect(snippet).toContain(token);
    expect(snippet).not.toContain(paste);
  });

  it('builds Claude self-check JSON with the placeholder and a rebuilt env', () => {
    const snippet = checkSnippet('claude', config, placeholder);
    expect(JSON.parse(snippet)).toEqual({
      mcpServers: {
        work_with_agent: {
          command: config.command,
          args: config.args,
          env: { WWA_API_URL: config.env.WWA_API_URL, WWA_CONNECTION_TOKEN: placeholder },
        },
      },
    });
    expect(snippet).toContain(placeholder);
    expect(snippet).not.toContain(token);
    expect(snippet).not.toContain(paste);
  });

  it('uses grok mcp add with http transport for setup and for the self-check placeholder', () => {
    const setup = setupSnippet('grok', config, token);
    const check = checkSnippet('grok', config, placeholder);
    expect(setup).toBe("grok mcp add work_with_agent --scope user --transport http http://127.0.0.1:3015/mcp --header 'Authorization: Bearer secret-token'");
    expect(check).toBe(`grok mcp add work_with_agent --scope user --transport http http://127.0.0.1:3015/mcp --header 'Authorization: Bearer ${placeholder}'`);
    expect(setup).toContain(token);
    expect(check).toContain(placeholder);
    expect(check).not.toContain(token);
    expect(check).not.toContain(paste);
    expect(check).not.toContain('[mcp_servers.work_with_agent]');
  });

  it('uses TOML for Codex setup and self-check', () => {
    const setup = setupSnippet('codex', config, token);
    const check = checkSnippet('codex', config, placeholder);
    const toml = (credential: string) => `[mcp_servers.work_with_agent]\ncommand = "/usr/bin/node"\nargs = ["src/mcp/index.js","--flag"]\n[mcp_servers.work_with_agent.env]\nWWA_API_URL = "http://127.0.0.1:3015"\nWWA_CONNECTION_TOKEN = ${JSON.stringify(credential)}`;
    expect(setup).toBe(toml(token));
    expect(check).toBe(toml(placeholder));
    expect(check).not.toContain(token);
    expect(check).not.toContain(paste);
  });

  it('writes a PowerShell single quote as two single quotes', () => {
    expect(quotePowerShell("a'b")).toBe("'a''b'");
    const quoted = setupSnippet('claude', { ...config, command: "C:\\tools\\node'x" }, "tok'en");
    expect(quoted).toContain("'C:\\tools\\node''x'");
    expect(quoted).toContain("'WWA_CONNECTION_TOKEN=tok''en'");
    expect(setupSnippet('grok', config, "tok'en")).toContain("'Authorization: Bearer tok''en'");
  });

  it('uses generic JSON for an unknown host and still omits the server placeholder', () => {
    const setup = setupSnippet('cursor', config, token);
    const check = checkSnippet('cursor', config, placeholder);
    expect(JSON.parse(setup)).toEqual({
      command: config.command,
      args: config.args,
      url: config.url,
      env: { WWA_API_URL: config.env.WWA_API_URL, WWA_CONNECTION_TOKEN: token },
    });
    expect(JSON.parse(check).env.WWA_CONNECTION_TOKEN).toBe(placeholder);
    expect(setup).not.toContain('claude mcp add');
    expect(setup).not.toContain('grok mcp add');
    expect(setup).not.toContain('[mcp_servers');
    expect(check).not.toContain(token);
    expect(check).not.toContain(paste);
  });
});
