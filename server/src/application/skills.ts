import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { DomainError } from '../domain/task.js';
import { prisma } from '../infrastructure/prisma.js';
import { runSerializedCommand } from './commands.js';
import type { Db } from './workspace-store.js';
import { codePoints } from '../agent/text.js';

const NAME_MAX = 80;
const DESCRIPTION_MAX = 1024;
const INSTRUCTIONS_MAX = 100_000;
const REASON_MAX = 1000;

export type SkillOrigin = 'manual' | 'import' | 'assistant';
export type SkillSource = 'manual' | 'import' | 'assistant' | 'rollback' | 'editor-from-proposal';
export type SkillDraft = { name: string; description: string; instructions: string };

type SkillRow = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
  revision: number;
  origin: string;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const skillNow = () => new Date().toISOString();

export function skillFailure(code: string, message: string, status = 409, details?: Record<string, unknown>) {
  const error = new DomainError(code, message, status);
  if (details) Object.assign(error, { details });
  return error;
}

function isUnique(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function cleanText(value: unknown, label: string, max: number) {
  if (typeof value !== 'string') throw skillFailure('VALIDATION_ERROR', `${label}必须是文本`, 400);
  const text = value.trim();
  const length = codePoints(text);
  if (length < 1 || length > max) throw skillFailure('VALIDATION_ERROR', `${label}需要 1～${max} 个字符`, 400);
  return text;
}

export function cleanSkillName(value: unknown) {
  const name = cleanText(value, '技能名称', NAME_MAX);
  if (/[\r\n]/.test(name)) throw skillFailure('VALIDATION_ERROR', '技能名称需要 1～80 个字符，且不能换行', 400);
  return name;
}

export function cleanSkillDescription(value: unknown) {
  return cleanText(value, '技能描述', DESCRIPTION_MAX);
}

export function cleanSkillInstructions(value: unknown) {
  return cleanText(value, '技能正文', INSTRUCTIONS_MAX);
}

function cleanReason(value: string) {
  const reason = value.trim();
  if (codePoints(reason) > REASON_MAX) throw skillFailure('VALIDATION_ERROR', `修改说明需要 1～${REASON_MAX} 个字符`, 400);
  return reason;
}

function defaultReason(existing: Pick<SkillRow, 'name' | 'description' | 'instructions' | 'enabled'> | null, next: { name: string; description: string; instructions: string; enabled: boolean }, given?: string) {
  if (given !== undefined) {
    const reason = cleanReason(given);
    if (reason) return reason;
  }
  if (!existing) return '新建';
  const contentSame = existing.name === next.name && existing.description === next.description && existing.instructions === next.instructions;
  if (contentSame && existing.enabled !== next.enabled) return next.enabled ? '启用' : '停用';
  return '修改';
}

function nameTaken(row: { id: string; revision: number }, draft?: SkillDraft) {
  return skillFailure('SKILL_NAME_TAKEN', '已有同名技能', 409, { skillId: row.id, revision: row.revision, ...(draft ? { draft } : {}) });
}

async function activeByName(tx: Db, name: string, exceptId?: string) {
  return tx.skill.findFirst({ where: { name, deletedAt: null, ...(exceptId ? { NOT: { id: exceptId } } : {}) } });
}

export async function persistSkill(tx: Db, spec: {
  id?: string;
  existing?: SkillRow | null;
  expectedRevision?: number;
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
  reason: string;
  source: SkillSource;
  origin?: SkillOrigin;
}) {
  const name = cleanSkillName(spec.name);
  const description = cleanSkillDescription(spec.description);
  const instructions = cleanSkillInstructions(spec.instructions);
  const reason = cleanReason(spec.reason) || defaultReason(spec.existing ?? null, { name, description, instructions, enabled: spec.enabled });
  const timestamp = skillNow();
  const taken = await activeByName(tx, name, spec.existing?.id);
  if (taken) throw nameTaken(taken);
  if (!spec.existing) {
    const origin = spec.origin ?? 'manual';
    try {
      const skill = await tx.skill.create({ data: { ...(spec.id ? { id: spec.id } : {}), name, description, instructions, enabled: spec.enabled, origin, revision: 1, createdAt: timestamp, updatedAt: timestamp } });
      await tx.skillVersion.create({ data: { skillId: skill.id, revision: 1, name, description, instructions, enabled: spec.enabled, reason, source: spec.source, createdAt: timestamp } });
      return skill;
    } catch (error) {
      if (!isUnique(error)) throw error;
      throw skillFailure('SKILL_NAME_TAKEN', '已有同名技能', 409);
    }
  }
  if (spec.existing.deletedAt) throw skillFailure('NOT_FOUND', '技能不存在', 404);
  if (!Number.isInteger(spec.expectedRevision) || spec.expectedRevision! < 1) throw skillFailure('VERSION_CONFLICT', '内容已经变化，请刷新后重试', 409, { currentRevision: spec.existing.revision });
  let updated: { count: number };
  try {
    updated = await tx.skill.updateMany({ where: { id: spec.existing.id, revision: spec.expectedRevision, deletedAt: null }, data: { name, description, instructions, enabled: spec.enabled, revision: { increment: 1 }, updatedAt: timestamp } });
  } catch (error) {
    if (!isUnique(error)) throw error;
    throw skillFailure('SKILL_NAME_TAKEN', '已有同名技能', 409);
  }
  if (!updated.count) {
    const current = await tx.skill.findUnique({ where: { id: spec.existing.id } });
    if (!current || current.deletedAt) throw skillFailure('NOT_FOUND', '技能不存在', 404);
    throw skillFailure('VERSION_CONFLICT', '内容已经变化，请刷新后重试', 409, { currentRevision: current.revision });
  }
  const skill = await tx.skill.findUniqueOrThrow({ where: { id: spec.existing.id } });
  await tx.skillVersion.create({ data: { skillId: skill.id, revision: skill.revision, name: skill.name, description: skill.description, instructions: skill.instructions, enabled: skill.enabled, reason, source: spec.source, createdAt: timestamp } });
  return skill;
}

function listItem(row: SkillRow) {
  return { id: row.id, name: row.name, description: row.description, enabled: row.enabled, revision: row.revision, origin: row.origin, updatedAt: row.updatedAt, deletedAt: row.deletedAt };
}

export async function listSkills(query: { q?: string; enabled?: boolean; origin?: string; deleted?: boolean } = {}) {
  const q = query.q?.trim();
  const rows = await prisma.skill.findMany({
    where: {
      deletedAt: query.deleted ? { not: null } : null,
      ...(query.enabled !== undefined ? { enabled: query.enabled } : {}),
      ...(query.origin ? { origin: query.origin } : {}),
      ...(q ? { OR: [{ name: { contains: q } }, { description: { contains: q } }] } : {}),
    },
    orderBy: [{ updatedAt: 'desc' }, { name: 'asc' }, { id: 'asc' }],
  });
  return rows.map(listItem);
}

export async function getSkill(id: string) {
  const skill = await prisma.skill.findUnique({ where: { id }, include: { versions: { orderBy: { revision: 'asc' }, select: { revision: true, reason: true, source: true, createdAt: true } } } });
  if (!skill) throw skillFailure('NOT_FOUND', '技能不存在', 404);
  const { versions, ...row } = skill;
  return { ...row, versions };
}

export async function getSkillVersion(id: string, revision: number) {
  if (!Number.isInteger(revision) || revision < 1) throw skillFailure('NOT_FOUND', '技能版本不存在', 404);
  const version = await prisma.skillVersion.findUnique({ where: { skillId_revision: { skillId: id, revision } } });
  if (!version) throw skillFailure('NOT_FOUND', '技能版本不存在', 404);
  return version;
}

export async function createSkill(input: { name: string; description: string; instructions: string; enabled?: boolean; reason?: string; origin?: SkillOrigin; source?: SkillSource; id?: string }) {
  const enabled = input.enabled ?? false;
  const name = input.name;
  const description = input.description;
  const instructions = input.instructions;
  return runSerializedCommand((tx) => persistSkill(tx, {
    id: input.id,
    name, description, instructions, enabled,
    reason: defaultReason(null, { name: typeof name === 'string' ? name.trim() : '', description: typeof description === 'string' ? description.trim() : '', instructions: typeof instructions === 'string' ? instructions.trim() : '', enabled }, input.reason),
    source: input.source ?? 'manual',
    origin: input.origin ?? 'manual',
  }));
}

export async function updateSkill(id: string, input: { expectedRevision: number; name?: string; description?: string; instructions?: string; enabled?: boolean; reason?: string; source?: SkillSource }) {
  return runSerializedCommand(async (tx) => {
    const existing = await tx.skill.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) throw skillFailure('NOT_FOUND', '技能不存在', 404);
    const next = {
      name: input.name ?? existing.name,
      description: input.description ?? existing.description,
      instructions: input.instructions ?? existing.instructions,
      enabled: input.enabled ?? existing.enabled,
    };
    return persistSkill(tx, { existing, expectedRevision: input.expectedRevision, ...next, reason: defaultReason(existing, next, input.reason), source: input.source ?? 'manual' });
  });
}

export async function rollbackSkill(id: string, input: { expectedRevision: number; targetRevision: number; reason?: string }) {
  return runSerializedCommand(async (tx) => {
    const existing = await tx.skill.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) throw skillFailure('NOT_FOUND', '技能不存在', 404);
    const version = await tx.skillVersion.findUnique({ where: { skillId_revision: { skillId: id, revision: input.targetRevision } } });
    if (!version) throw skillFailure('NOT_FOUND', '技能版本不存在', 404);
    const next = { name: version.name, description: version.description, instructions: version.instructions, enabled: version.enabled };
    const reason = input.reason !== undefined && input.reason.trim() ? cleanReason(input.reason) : `回滚到 v${input.targetRevision}`;
    return persistSkill(tx, { existing, expectedRevision: input.expectedRevision, ...next, reason, source: 'rollback' });
  });
}

export async function deleteSkill(id: string, expectedRevision: number) {
  return runSerializedCommand(async (tx) => {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw skillFailure('VERSION_CONFLICT', '内容已经变化，请刷新后重试', 409);
    const timestamp = skillNow();
    const updated = await tx.skill.updateMany({ where: { id, revision: expectedRevision, deletedAt: null }, data: { deletedAt: timestamp, enabled: false, updatedAt: timestamp } });
    if (!updated.count) {
      const current = await tx.skill.findUnique({ where: { id } });
      if (!current || current.deletedAt) throw skillFailure('NOT_FOUND', '技能不存在', 404);
      throw skillFailure('VERSION_CONFLICT', '内容已经变化，请刷新后重试', 409, { currentRevision: current.revision });
    }
    return tx.skill.findUniqueOrThrow({ where: { id } });
  });
}

export async function restoreSkill(id: string) {
  return runSerializedCommand(async (tx) => {
    const existing = await tx.skill.findUnique({ where: { id } });
    if (!existing || !existing.deletedAt) throw skillFailure('NOT_FOUND', '技能不存在', 404);
    const taken = await activeByName(tx, existing.name);
    if (taken) throw nameTaken(taken);
    const timestamp = skillNow();
    try {
      return await tx.skill.update({ where: { id }, data: { deletedAt: null, updatedAt: timestamp } });
    } catch (error) {
      if (!isUnique(error)) throw error;
      throw skillFailure('SKILL_NAME_TAKEN', '已有同名技能，请改名后再恢复', 409);
    }
  });
}

const DIFF_KEYS = ['name', 'description', 'instructions', 'enabled'] as const;

export function diffLines(before: string, after: string) {
  const left = before.split('\n');
  const right = after.split('\n');
  const n = left.length;
  const m = right.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) dp[i][j] = left[i] === right[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const lines: Array<{ type: 'same' | 'add' | 'remove'; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (left[i] === right[j]) { lines.push({ type: 'same', text: left[i] }); i += 1; j += 1; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { lines.push({ type: 'remove', text: left[i] }); i += 1; }
    else { lines.push({ type: 'add', text: right[j] }); j += 1; }
  }
  while (i < n) lines.push({ type: 'remove', text: left[i++] });
  while (j < m) lines.push({ type: 'add', text: right[j++] });
  return lines;
}

export async function diffSkill(id: string, from: number, to: number) {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < 1) throw skillFailure('VALIDATION_ERROR', '请指定要对比的两个版本', 400);
  const skill = await prisma.skill.findUnique({ where: { id }, select: { id: true } });
  if (!skill) throw skillFailure('NOT_FOUND', '技能不存在', 404);
  const [left, right] = await Promise.all([
    prisma.skillVersion.findUnique({ where: { skillId_revision: { skillId: id, revision: from } } }),
    prisma.skillVersion.findUnique({ where: { skillId_revision: { skillId: id, revision: to } } }),
  ]);
  if (!left || !right) throw skillFailure('NOT_FOUND', '技能版本不存在', 404);
  const fields = DIFF_KEYS.flatMap((key) => left[key] === right[key] ? [] : [{ key, before: left[key], after: right[key] }]);
  return { from, to, fields, lines: diffLines(left.instructions, right.instructions) };
}

function unquote(value: string) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value.replace(/\s+#.*$/, '').trim();
}

function parseFrontmatter(front: string) {
  const lines = front.split('\n');
  const values: Record<string, string> = {};
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    const raw = match[2] ?? '';
    const block = /^([|>])([-+])?\s*(?:#.*)?$/.exec(raw);
    let value = '';
    if (block) {
      const folded = block[1] === '>';
      const collected: string[] = [];
      let base: number | null = null;
      index += 1;
      for (; index < lines.length; index += 1) {
        const next = lines[index] ?? '';
        if (!next.trim()) { collected.push(''); continue; }
        const indent = /^ */.exec(next)?.[0].length ?? 0;
        if (indent === 0) { index -= 1; break; }
        if (base === null) base = indent;
        if (indent < base) { index -= 1; break; }
        collected.push(next.slice(base));
      }
      if (folded) {
        const parts: string[] = [];
        let buffer: string[] = [];
        for (const row of collected) {
          if (!row.trim()) {
            if (buffer.length) parts.push(buffer.join(' '));
            buffer = [];
          } else buffer.push(row.trim());
        }
        if (buffer.length) parts.push(buffer.join(' '));
        value = parts.join('\n').trim();
      } else value = collected.join('\n').replace(/\n+$/, '');
    } else value = unquote(raw).trim();
    if (key === 'name' || key === 'description') values[key] = value;
  }
  return values;
}

export function parseSkillMarkdown(markdown: string): SkillDraft {
  const text = String(markdown ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const opened = (lines[0] ?? '').trim() === '---';
  let close = -1;
  if (opened) {
    for (let index = 1; index < lines.length; index += 1) if ((lines[index] ?? '').trim() === '---') { close = index; break; }
  }
  const missing: string[] = [];
  if (!opened || close < 0) missing.push('frontmatter');
  const values = opened && close >= 0 ? parseFrontmatter(lines.slice(1, close).join('\n')) : {};
  const body = opened && close >= 0 ? lines.slice(close + 1).join('\n').trim() : '';
  if (!values.name?.trim()) missing.push('name');
  if (!values.description?.trim()) missing.push('description');
  if (!body) missing.push('正文');
  if (missing.length) throw skillFailure('SKILL_MARKDOWN_INVALID', `SKILL.md 缺少：${missing.join('、')}`, 400, { missing });
  return { name: values.name.trim(), description: values.description.trim(), instructions: body };
}

export async function importSkill(input: { markdown: string; resolution?: 'version' | 'rename'; expectedRevision?: number; name?: string }) {
  const draft = parseSkillMarkdown(input.markdown);
  cleanSkillName(draft.name);
  cleanSkillDescription(draft.description);
  cleanSkillInstructions(draft.instructions);
  return runSerializedCommand(async (tx) => {
    const existing = await activeByName(tx, cleanSkillName(draft.name));
    if (!existing) return persistSkill(tx, { ...draft, enabled: false, reason: '导入 SKILL.md', source: 'import', origin: 'import' });
    if (!input.resolution) throw nameTaken(existing, draft);
    if (input.resolution === 'version') {
      if (!Number.isInteger(input.expectedRevision)) throw skillFailure('VALIDATION_ERROR', '覆盖为新版本需要 expectedRevision', 400);
      return persistSkill(tx, { existing, expectedRevision: input.expectedRevision, ...draft, enabled: existing.enabled, reason: '导入 SKILL.md 覆盖', source: 'import' });
    }
    const renamed = cleanSkillName(input.name);
    return persistSkill(tx, { name: renamed, description: draft.description, instructions: draft.instructions, enabled: false, reason: '导入 SKILL.md', source: 'import', origin: 'import' });
  });
}

export async function enabledSkillCatalog(db: Db = prisma) {
  return db.skill.findMany({ where: { enabled: true, deletedAt: null }, select: { name: true, description: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] });
}

const draftSchema = z.object({ name: z.string(), description: z.string(), instructions: z.string() }).strict();
type DraftModel = { complete(messages: Array<{ role: 'system' | 'user'; content: string }>, signal?: AbortSignal, includeTools?: boolean): Promise<{ text: string }> };
let draftModel: DraftModel | null = null;

export function setSkillDraftModel(model: DraftModel | null) { draftModel = model; }

function clipPoints(text: string, max: number) {
  const points = [...text];
  return points.length <= max ? text : points.slice(0, max).join('');
}

export async function draftSkill(conversationId: string, model?: DraftModel) {
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { id: true } });
  if (!conversation) throw skillFailure('NOT_FOUND', '会话不存在', 404);
  const rows = await prisma.message.findMany({ where: { conversationId, role: { in: ['user', 'assistant'] } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 30 });
  const transcript = rows.reverse().map((row) => `${row.role === 'assistant' ? '助手' : '用户'}：${clipPoints(row.content, 2000)}`).join('\n\n');
  const completer = model ?? draftModel;
  if (!completer) {
    const { ModelAdapter } = await import('../agent.js');
    setSkillDraftModel(new ModelAdapter());
  }
  const active = model ?? draftModel;
  if (!active) throw skillFailure('MODEL_NOT_CONFIGURED', '未配置模型服务', 400);
  const generated = await active.complete([
    { role: 'system', content: '你根据对话起草一条可复用技能。只输出严格 JSON，不要使用 Markdown 代码围栏。字段只有 name、description、instructions。name 1～80 字且不换行，description 1～1024 字，instructions 是 Markdown 正文。不要写入数据库，不要调用工具。' },
    { role: 'user', content: transcript || '（对话是空的）' },
  ], AbortSignal.timeout(90_000), false);
  const raw = generated.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw skillFailure('INVALID_MODEL_OUTPUT', '模型没有返回有效 JSON，技能未保存', 502); }
  const result = draftSchema.safeParse(parsed);
  if (!result.success) throw skillFailure('INVALID_MODEL_OUTPUT', '模型没有返回有效 JSON，技能未保存', 502);
  try {
    return { name: cleanSkillName(result.data.name), description: cleanSkillDescription(result.data.description), instructions: cleanSkillInstructions(result.data.instructions) };
  } catch {
    throw skillFailure('INVALID_MODEL_OUTPUT', '模型没有返回有效 JSON，技能未保存', 502);
  }
}
