import { stripVTControlCharacters } from 'node:util';
import { asObject } from './harness-codex.js';
import { HARNESS_OUTPUT_LIMIT, type HarnessTool } from './harness-protocol.js';

function text(value: unknown) { return typeof value === 'string' ? value : ''; }

export function harnessOutput(value: unknown) {
  const raw = text(value);
  const clean = stripVTControlCharacters(raw.slice(-HARNESS_OUTPUT_LIMIT * 2)).replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/g, '');
  return { output: clean.slice(-HARNESS_OUTPUT_LIMIT), truncated: raw.length > HARNESS_OUTPUT_LIMIT * 2 || clean.length > HARNESS_OUTPUT_LIMIT };
}

export function harnessFilePaths(changes: unknown): string[] {
  if (!Array.isArray(changes)) return [];
  return changes.slice(0, 8).map((change) => text(asObject(change).path).slice(0, 600)).filter(Boolean);
}

export function harnessFileDiffs(changes: unknown): NonNullable<HarnessTool['diffs']> {
  if (!Array.isArray(changes)) return [];
  return changes.slice(0, 8).map(asObject).flatMap((change) => {
    const path = text(change.path).slice(0, 600);
    const diff = text(change.diff);
    if (!path || !diff) return [];
    const kind = asObject(change.kind).type;
    const lines = diff.split('\n');
    if (lines.at(-1) === '') lines.pop();
    let inHunk = lines.some((line) => line.startsWith('@@ ')) ? false : kind === 'update';
    let added = 0, removed = 0;
    for (const line of lines) {
      if (line.startsWith('@@ ')) { inHunk = true; continue; }
      if (!inHunk) continue;
      if (line.startsWith('+')) added += 1;
      if (line.startsWith('-')) removed += 1;
    }
    if (!inHunk && kind === 'add') added = lines.length;
    if (!inHunk && kind === 'delete') removed = lines.length;
    return [{ path, added, removed, patch: diff.slice(0, 1500), truncated: diff.length > 1500 }];
  });
}

/** Only project user-visible fields from the executor. Raw tool arguments and results stay local. */
export function codexHarnessTool(item: Record<string, unknown>, turnId: string, completed: boolean): HarnessTool | null {
  const id = text(item.id);
  if (!id || !turnId) return null;
  const status = item.status === 'inProgress' || !completed ? 'running'
    : item.status === 'declined' ? 'interrupted' : item.status === 'failed' ? 'failed' : 'completed';
  const base = { id, turnId, status } as const;
  switch (item.type) {
    case 'commandExecution': {
      const exitCode = typeof item.exitCode === 'number' && Number.isInteger(item.exitCode) ? item.exitCode : undefined;
      const output = typeof item.aggregatedOutput === 'string' && item.aggregatedOutput ? harnessOutput(item.aggregatedOutput) : undefined;
      return { ...base, kind: 'command', title: text(item.command).slice(0, 1_000),
        status: status === 'completed' && exitCode ? 'failed' : status,
        ...(exitCode === undefined ? {} : { exitCode }), ...output };
    }
    case 'fileChange':
      return { ...base, kind: 'fileChange', title: '', files: harnessFilePaths(item.changes), diffs: harnessFileDiffs(item.changes) };
    case 'mcpToolCall':
    case 'dynamicToolCall':
      return { ...base, kind: 'tool', title: text(item.tool).slice(0, 1_000) };
    case 'webSearch':
      return { ...base, kind: 'webSearch', title: text(item.query).slice(0, 1_000) };
    case 'imageView':
    case 'imageGeneration':
      return { ...base, kind: 'image', title: '' };
    default:
      return null;
  }
}
