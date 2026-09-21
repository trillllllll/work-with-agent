/** A new runner is not a child conversation of whichever AI launched the web server. */
export function providerEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (key.startsWith('CODEX_') && !['CODEX_HOME', 'CODEX_API_KEY'].includes(key)) delete env[key];
  }
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}
