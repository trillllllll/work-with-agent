export type ConnectionConfiguration = {
  command: string;
  args: string[];
  url: string;
  env: { DOVUN_API_URL?: string; DOVUN_CONNECTION_TOKEN?: string; WWA_API_URL: string; WWA_CONNECTION_TOKEN: string };
};

export type McpEntryName = 'dovun' | 'work_with_agent';
const apiUrl = (config: ConnectionConfiguration) => config.env.DOVUN_API_URL ?? config.env.WWA_API_URL;

/** PowerShell single-quotes a value and escapes an embedded quote by doubling it. */
export function quotePowerShell(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function claudeCommand(config: ConnectionConfiguration, token: string) {
  const quotedArgs = config.args.map(quotePowerShell).join(' ');
  const apiEnv = quotePowerShell(`DOVUN_API_URL=${apiUrl(config)}`);
  const tokenEnv = quotePowerShell(`DOVUN_CONNECTION_TOKEN=${token}`);
  return `claude mcp add dovun ${quotePowerShell(config.command)} ${quotedArgs} --scope user --env ${apiEnv} ${tokenEnv}`;
}

function grokCommand(config: ConnectionConfiguration, token: string) {
  return `grok mcp add dovun --scope user --transport http ${config.url} --header ${quotePowerShell(`Authorization: Bearer ${token}`)}`;
}

function codexConfig(config: ConnectionConfiguration, token: string) {
  return `[mcp_servers.dovun]\ncommand = ${JSON.stringify(config.command)}\nargs = ${JSON.stringify(config.args)}\n[mcp_servers.dovun.env]\nDOVUN_API_URL = ${JSON.stringify(apiUrl(config))}\nDOVUN_CONNECTION_TOKEN = ${JSON.stringify(token)}`;
}

/** Claude self-check JSON. Env is rebuilt so a server placeholder in config.env is not copied. */
function claudeCheckJson(config: ConnectionConfiguration, token: string) {
  return JSON.stringify({
    mcpServers: {
      dovun: {
        command: config.command,
        args: config.args,
        env: { DOVUN_API_URL: apiUrl(config), DOVUN_CONNECTION_TOKEN: token },
      },
    },
  }, null, 2);
}

function genericJson(config: ConnectionConfiguration, token: string) {
  return JSON.stringify({
    command: config.command,
    args: config.args,
    url: config.url,
    env: { DOVUN_API_URL: apiUrl(config), DOVUN_CONNECTION_TOKEN: token },
  }, null, 2);
}

/** Setup snippet. `token` is the credential; config.env.WWA_CONNECTION_TOKEN is not copied. */
export function setupSnippet(host: string, config: ConnectionConfiguration, token: string, entry: McpEntryName = 'dovun') {
  if (entry === 'work_with_agent') {
    if (host === 'codex') return codexConfig(config, token).split('mcp_servers.dovun').join('mcp_servers.work_with_agent');
    if (host === 'claude') return claudeCheckJson(config, token).replace('"dovun":', '"work_with_agent":');
    // Existing HTTP entries are edited in place; never offer a second add command.
    return JSON.stringify({ entry: 'work_with_agent', url: config.url, headers: { Authorization: `Bearer ${token}` } }, null, 2);
  }
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
