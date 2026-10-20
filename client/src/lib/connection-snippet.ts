export type ConnectionConfiguration = {
  command: string;
  args: string[];
  url: string;
  env: { WWA_API_URL: string; WWA_CONNECTION_TOKEN: string };
};

/** PowerShell single-quotes a value and escapes an embedded quote by doubling it. */
export function quotePowerShell(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function claudeCommand(config: ConnectionConfiguration, token: string) {
  const quotedArgs = config.args.map(quotePowerShell).join(' ');
  const apiEnv = quotePowerShell(`WWA_API_URL=${config.env.WWA_API_URL}`);
  const tokenEnv = quotePowerShell(`WWA_CONNECTION_TOKEN=${token}`);
  return `claude mcp add work_with_agent ${quotePowerShell(config.command)} ${quotedArgs} --scope user --env ${apiEnv} ${tokenEnv}`;
}

function grokCommand(config: ConnectionConfiguration, token: string) {
  return `grok mcp add work_with_agent --scope user --transport http ${config.url} --header ${quotePowerShell(`Authorization: Bearer ${token}`)}`;
}

function codexConfig(config: ConnectionConfiguration, token: string) {
  return `[mcp_servers.work_with_agent]\ncommand = ${JSON.stringify(config.command)}\nargs = ${JSON.stringify(config.args)}\n[mcp_servers.work_with_agent.env]\nWWA_API_URL = ${JSON.stringify(config.env.WWA_API_URL)}\nWWA_CONNECTION_TOKEN = ${JSON.stringify(token)}`;
}

/** Claude self-check JSON. Env is rebuilt so a server placeholder in config.env is not copied. */
function claudeCheckJson(config: ConnectionConfiguration, token: string) {
  return JSON.stringify({
    mcpServers: {
      work_with_agent: {
        command: config.command,
        args: config.args,
        env: { WWA_API_URL: config.env.WWA_API_URL, WWA_CONNECTION_TOKEN: token },
      },
    },
  }, null, 2);
}

function genericJson(config: ConnectionConfiguration, token: string) {
  return JSON.stringify({
    command: config.command,
    args: config.args,
    url: config.url,
    env: { WWA_API_URL: config.env.WWA_API_URL, WWA_CONNECTION_TOKEN: token },
  }, null, 2);
}

/** Setup snippet. `token` is the credential; config.env.WWA_CONNECTION_TOKEN is not copied. */
export function setupSnippet(host: string, config: ConnectionConfiguration, token: string) {
  if (host === 'codex') return codexConfig(config, token);
  if (host === 'claude') return claudeCommand(config, token);
  if (host === 'grok') return grokCommand(config, token);
  return genericJson(config, token);
}

/** Self-check snippet. `placeholder` replaces the credential in every host format. */
export function checkSnippet(host: string, config: ConnectionConfiguration, placeholder: string) {
  if (host === 'codex') return codexConfig(config, placeholder);
  if (host === 'claude') return claudeCheckJson(config, placeholder);
  if (host === 'grok') return grokCommand(config, placeholder);
  return genericJson(config, placeholder);
}
