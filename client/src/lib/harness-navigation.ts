export type HarnessSessionTarget = {
  id: string;
  harness?: string;
  project?: string;
};

export function harnessSessionsHash(target?: HarnessSessionTarget) {
  const params = new URLSearchParams({ tab: 'sessions' });
  if (target?.id) {
    params.set('sessionId', target.id);
    if (target.harness) params.set('harness', target.harness);
    if (target.project) params.set('project', target.project);
  }
  return `/runs?${params.toString()}`;
}
