#!/usr/bin/env node
// Stub Codex for orchestration tests: does the git work a real local AI would do, then writes final.json.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const startedAt = Date.now();
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('stub-codex 0.0.0'); process.exit(0); }
const output = args[args.indexOf('--output-last-message') + 1];
const prompt = readFileSync(0, 'utf8');
const cwd = process.cwd();
const git = (...rest) => execFileSync('git', ['-c', 'user.name=stub', '-c', 'user.email=stub@example.com', ...rest], { cwd, encoding: 'utf8' }).trim();
console.log(JSON.stringify({ type: 'thread.started', thread_id: `stub-${process.pid}` }));
console.log(JSON.stringify({ type: 'turn.started' }));
const delay = Number(process.env.STUB_DELAY_MS ?? 400);
const until = Date.now() + delay; while (Date.now() < until) { /* overlap window for the parallel assertion */ }
const result = { outcome: 'ready_for_review', summary: '', questions: [], artifacts: [], checks: [], unfinished: [], proposedCommandsJson: '[]' };
const log = (line) => { if (process.env.STUB_LOG) writeFileSync(process.env.STUB_LOG, `${line}\n`, { flag: 'a' }); };

if (prompt.includes('## 独立核对任务')) {
  const head = git('rev-parse', 'HEAD');
  const failTests = existsSync(join(cwd, 'FAIL_VERIFY'));
  result.summary = `核对 HEAD ${head}`;
  result.checks = [{ name: 'npm test', passed: !failTests, detail: failTests ? '1 failed' : 'all passed' }];
  result.artifacts = [{ name: 'wwa-report.json', kind: 'text', content: JSON.stringify({ branch: git('symbolic-ref', '--short', 'HEAD'), head, includes: {}, conflictMarkers: [], tests: [] }) }];
  log(`verify ${head}`);
} else if (prompt.includes('## 合入任务')) {
  const branch = prompt.match(/git merge --no-ff ([^\s`]+)/)[1];
  git('merge', '--no-ff', '--no-edit', branch);
  result.summary = `merged ${branch}`;
  result.checks = [{ name: 'npm test', passed: true, detail: 'ok' }];
  log(`merge ${branch} ${Date.now()}`);
} else {
  const task = JSON.parse(prompt.match(/本次子任务：(\{.*\})/)[1]);
  const name = task.title.replace(/[^A-Za-z0-9]+/g, '-');
  let content = `${task.title}\n`;
  if (task.description.includes('needs A')) content += existsSync(join(cwd, 'Task-A.txt')) ? 'saw A\n' : 'missing A\n';
  if (task.description.includes('forget commit') && !prompt.includes('主控对上一次结果的意见')) { writeFileSync(join(cwd, `${name}.txt`), content); result.summary = 'forgot to commit'; log(`develop ${task.title} ${startedAt} ${Date.now()} nocommit`); }
  else {
    writeFileSync(join(cwd, `${name}.txt`), content);
    git('add', '-A'); git('commit', '-m', `wwa: ${task.title}`);
    result.summary = `did ${task.title}`;
    result.checks = [{ name: 'unit', passed: true, detail: '' }];
    log(`develop ${task.title} ${startedAt} ${Date.now()}`);
  }
}
writeFileSync(output, JSON.stringify(result));
