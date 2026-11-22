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
      return { ...base, kind: 'fileChange', title: '', files: harnessFilePaths(item.changes) };
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
