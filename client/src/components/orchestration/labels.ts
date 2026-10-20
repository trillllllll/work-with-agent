import { t } from '../../i18n/index.js';

function labels(group: string, ids: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const id of ids) Object.defineProperty(result, id, { enumerable: true, get: () => t(`orchestration:${group}.${id}`) });
  return result;
}

export const orchestrationStatusLabels = labels('status', ['draft', 'running', 'paused', 'awaiting_acceptance', 'accepted', 'cancelled', 'superseded']);
export const stepStatusLabels = labels('stepStatus', ['pending', 'queued', 'dispatched', 'reverify', 'verifying', 'retry_wait', 'needs_user', 'succeeded', 'skipped', 'failed']);
export const stepKindLabels = labels('stepKind', ['setup', 'develop', 'merge', 'final', 'push', 'publish', 'pull_request']);
export const pauseReasonLabels = labels('pauseReason', [
  'user_paused', 'node_offline', 'setup_failed', 'develop_failed', 'rate_limited', 'git_write_denied',
  'merge_conflict_unresolved', 'merge_tests_failed', 'merge_unverified', 'invalid_model_output',
  'final_unsatisfied', 'task_revised', 'transfer_failed',
]);
export const locationStatusLabels = labels('locationStatus', ['pending', 'verified', 'failed']);
