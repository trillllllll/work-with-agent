/** Pure comparisons of reports. The server only compares fields; it never inspects the workspace. */
import type { GitFacts } from '../../node-agent/protocol.js';
import type { RunResult } from '../../runner/contracts.js';

export type CheckOutcome = { ok: boolean; problems: string[] };
const failedChecks = (result: RunResult | null) => (result?.checks ?? []).filter((check) => !check.passed).map((check) => check.name);

export function checkDevelop(input: { result: RunResult | null; facts: GitFacts | null; base: string; branch: string; error?: string | null }): CheckOutcome {
  const problems: string[] = [];
  const { result, facts } = input;
  if (input.error) problems.push(`运行出错：${input.error.slice(0, 500)}`);
  if (!result) problems.push('本机 AI 没有返回有效的结构化结果');
  else if (result.outcome !== 'ready_for_review') problems.push(`AI 结果为 ${result.outcome}`);
  const failed = failedChecks(result);
  if (failed.length) problems.push(`检查未通过：${failed.join('、')}`);
  if (!facts) problems.push('执行端没有采集到 git 事实');
  else {
    if (facts.branch !== input.branch) problems.push(`分支不符：期望 ${input.branch}，实际 ${facts.branch ?? '（分离 HEAD）'}`);
    if (!facts.head || facts.head === input.base) problems.push('没有新的提交（改动必须提交到子任务分支）');
    if (facts.status.length) problems.push(`工作区有未提交的改动：${facts.status.slice(0, 5).join('; ')}`);
    if (facts.mergeInProgress || facts.unmerged.length) problems.push('存在未完成的合并');
    if (facts.hooksChanged) problems.push('git hooks 在运行中被修改');
  }
  return { ok: !problems.length, problems };
}

export function checkMerge(input: { result: RunResult | null; facts: GitFacts | null; integrationBranch: string; preHead: string | null; resultCommit: string; error?: string | null }): CheckOutcome {
  const problems: string[] = [];
  const { result, facts } = input;
  if (input.error) problems.push(`运行出错：${input.error.slice(0, 500)}`);
  if (!result) problems.push('本机 AI 没有返回有效的结构化结果');
  else if (result.outcome !== 'ready_for_review') problems.push(`AI 结果为 ${result.outcome}`);
  const failed = failedChecks(result);
  if (failed.length) problems.push(`检查未通过：${failed.join('、')}`);
  if (!facts) problems.push('执行端没有采集到 git 事实');
  else {
    if (facts.branch !== input.integrationBranch) problems.push(`集成分支不符：实际 ${facts.branch ?? '（分离 HEAD）'}`);
    if (facts.mergeInProgress) problems.push('合并仍在进行中（MERGE_HEAD 存在）');
    if (facts.unmerged.length) problems.push(`仍有未解决冲突：${facts.unmerged.slice(0, 5).join('、')}`);
    if (facts.status.length) problems.push('集成工作区不干净');
    if (facts.includes[input.resultCommit] !== true) problems.push('子任务提交不在集成分支中');
    if (input.preHead && facts.includes[input.preHead] !== true) problems.push('集成分支历史被改写');
    if (facts.conflictMarkers.length) problems.push(`残留冲突标记：${facts.conflictMarkers.slice(0, 5).join('、')}`);
    if (facts.hooksChanged) problems.push('git hooks 在运行中被修改');
  }
  return { ok: !problems.length, problems };
}

/** The independent verify run must see the same HEAD and pass its own checks. */
export function checkVerify(input: { result: RunResult | null; facts: GitFacts | null; expectedHead: string; resultCommit: string; error?: string | null }): CheckOutcome {
  const problems: string[] = [];
  const { result, facts } = input;
  if (input.error) problems.push(`核对运行出错：${input.error.slice(0, 500)}`);
  if (!result) problems.push('核对运行没有返回有效结果');
  else if (result.outcome !== 'ready_for_review') problems.push(`核对结果为 ${result.outcome}`);
  const failed = failedChecks(result);
  if (failed.length) problems.push(`核对检查未通过：${failed.join('、')}`);
  if (!facts) problems.push('执行端没有采集到 git 事实');
  else {
    if (facts.head !== input.expectedHead) problems.push(`HEAD 不一致：合入报告 ${input.expectedHead.slice(0, 12)}，核对时 ${facts.head?.slice(0, 12) ?? '无'}`);
    if (facts.includes[input.resultCommit] !== true) problems.push('核对时子任务提交不在集成分支中');
    if (facts.status.length) problems.push('核对运行修改了工作区');
    if (facts.conflictMarkers.length) problems.push('核对发现冲突标记');
  }
  const report = result?.artifacts.find((artifact) => artifact.name === 'wwa-report.json');
  if (report?.content) {
    try {
      const parsed = JSON.parse(report.content) as { head?: string };
      if (parsed.head && !input.expectedHead.startsWith(parsed.head) && !parsed.head.startsWith(input.expectedHead)) problems.push('核对 AI 报告的 HEAD 与执行端事实不一致');
    } catch { problems.push('wwa-report.json 不是有效 JSON'); }
  }
  return { ok: !problems.length, problems };
}

const rateLimited = /rate.?limit|\b429\b|usage limit|overloaded|RESOURCE_EXHAUSTED|quota/i;
export function looksRateLimited(text: string | null | undefined) { return !!text && rateLimited.test(text); }
const gitDenied = /index\.lock|Read-only file system/i;
export function looksGitWriteDenied(text: string | null | undefined) { return !!text && gitDenied.test(text); }
