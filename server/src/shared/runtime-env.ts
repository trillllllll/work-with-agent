/** 0.4 accepts only the current configuration names. Historical import is separate. */
export function runtimeEnv(suffix: string, env: NodeJS.ProcessEnv = process.env) {
  return env[`DOVUN_${suffix}`];
}

/** Image defaults never shadow explicit settings from either naming generation. */
export function runtimeSetting(suffix: string, containerFallback: string, env: NodeJS.ProcessEnv = process.env) {
  return runtimeEnv(suffix, env) ?? (env.DOVUN_CONTAINER === '1' ? containerFallback : undefined);
}

/** Reject obsolete-only configuration; detecting an old installation is not runtime fallback. */
export function assertCurrentEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const obsolete = Object.keys(env).filter(key => key.startsWith('WWA_') && env[key] && (env[`DOVUN_${key.slice(4)}`] === undefined || (key === 'WWA_DATA_DIR' && !env.DOVUN_DATA_DIR?.trim())));
  if (obsolete.length) throw new Error(`Obsolete configuration: ${obsolete.join(', ')}. Stop the old workspace, back up or migrate its data, and configure the corresponding DOVUN_* keys before starting. No empty workspace was created.`);
}
