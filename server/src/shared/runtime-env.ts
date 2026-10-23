/** 0.3 transition: prefer Dovun configuration, keeping the old key for one release. */
const warned = new Set<string>();
export function runtimeEnv(suffix: string, env: NodeJS.ProcessEnv = process.env, warn: (message: string) => void = console.warn) {
  const current = `DOVUN_${suffix}`;
  const legacy = `WWA_${suffix}`;
  if (env[current] !== undefined && env[legacy] !== undefined && env[legacy] !== '' && env[current] !== env[legacy] && !warned.has(suffix)) {
    warned.add(suffix);
    // Values can be credentials. Report names only.
    warn(`[Dovun] ${current} and ${legacy} differ; using ${current}.`);
  }
  return env[current] ?? env[legacy];
}

/** Image defaults never shadow explicit settings from either naming generation. */
export function runtimeSetting(suffix: string, containerFallback: string, env: NodeJS.ProcessEnv = process.env) {
  return runtimeEnv(suffix, env) ?? (env.DOVUN_CONTAINER === '1' ? containerFallback : undefined);
}
