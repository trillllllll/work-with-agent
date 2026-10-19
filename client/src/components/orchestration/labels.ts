export const orchestrationStatusLabels: Record<string, string> = { draft: '待确认', running: '运行中', paused: '已暂停', awaiting_acceptance: '待验收', accepted: '已验收', cancelled: '已取消', superseded: '已被新一轮取代' };
export const stepStatusLabels: Record<string, string> = { pending: '等待中', queued: '排队合入', dispatched: '执行端处理中', reverify: '等待核对', verifying: '独立核对中', retry_wait: '限流退避', needs_user: '需要你处理', succeeded: '完成', skipped: '已跳过', failed: '失败' };
export const stepKindLabels: Record<string, string> = { setup: '建集成分支', develop: '开发', merge: '合入', final: '最终审阅', push: '推送' };
export const pauseReasonLabels: Record<string, string> = {
  user_paused: '你暂停了运行', node_offline: '执行端离线，等它重新上线后自动继续', setup_failed: '集成分支准备失败', develop_failed: '子任务未通过验收', rate_limited: '本机 AI 额度限流',
  git_write_denied: '本机 AI 无法写 git（Codex 沙箱），可改用 Claude 或升级 Codex', merge_conflict_unresolved: '合入冲突没有解决', merge_tests_failed: '合入后测试未通过', merge_unverified: '合入结果未通过核对',
  invalid_model_output: '主控模型输出无效', final_unsatisfied: '主控认为主任务尚未满足要求', task_revised: '子任务在派发后被修改',
};
