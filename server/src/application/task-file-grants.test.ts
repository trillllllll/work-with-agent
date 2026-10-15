import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ControlledExecutionAdapter, ToolService, prisma } from '../services.js';
import { formatSystemPrompt } from './conversation.js';
import { isBroadDirectory, pathsInText, taskFileGrants } from './task-file-grants.js';

const createdTasks: string[] = [];
const createdDirs: string[] = [];

afterEach(async () => {
  if (createdTasks.length) await prisma.task.deleteMany({ where: { id: { in: createdTasks.splice(0) } } });
  await Promise.all(createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir() {
  const root = await mkdtemp(join(tmpdir(), 'wwa-grant-'));
  createdDirs.push(root);
  // /tmp is shallower than macOS tmpdir(); keep granted fixture directories
  // beyond the production rule's three-segment boundary on every platform.
  const dir = join(root, 'fixtures');
  await mkdir(dir);
  return dir;
}

describe('task file grants', () => {
  it('reads a file cited in a task and lists only that directory', async () => {
    const root = await tempDir();
    const dir = join(root, 'workflow');
    const nested = join(dir, 'nested');
    await mkdir(nested, { recursive: true });
    const file = join(dir, 'note.html');
    const sibling = join(dir, 'other.txt');
    const hidden = join(nested, 'secret.txt');
    const outsider = join(root, 'outsider.txt');
    await writeFile(file, 'hello-grant');
    await writeFile(sibling, 'sibling');
    await writeFile(hidden, 'hidden');
    await writeFile(outsider, 'nope');
    const task = await prisma.task.create({ data: { title: '文件授权', description: `见 file://${file} ，https://example.com/not-a-file` } });
    createdTasks.push(task.id);

    const grants = await taskFileGrants();
    expect(grants.files).toContain(file);
    expect(grants.directories).toContain(dir);

    const execution = new ControlledExecutionAdapter();
    const read = await execution.execute({ kind: 'file', input: { operation: 'read', path: await realpath(file) }, approvalId: 'a', fileGrants: grants });
    expect(read.success).toBe(true);
    expect(read.data).toMatchObject({ content: 'hello-grant' });
    const listed = await execution.execute({ kind: 'file', input: { operation: 'list', path: dir }, approvalId: 'a', fileGrants: grants });
    expect(listed.success).toBe(true);
    expect(listed.data).toMatchObject({ entries: expect.arrayContaining([{ name: 'note.html', kind: 'file' }, { name: 'other.txt', kind: 'file' }]) });
    const siblingRead = await execution.execute({ kind: 'file', input: { operation: 'read', path: sibling }, approvalId: 'a', fileGrants: grants });
    expect(siblingRead.success).toBe(true);
    expect((await execution.execute({ kind: 'file', input: { operation: 'read', path: hidden }, approvalId: 'a', fileGrants: grants })).errorCode).toBe('FILE_PATH_DENIED');
    expect((await execution.execute({ kind: 'file', input: { operation: 'read', path: outsider }, approvalId: 'a', fileGrants: grants })).errorCode).toBe('FILE_PATH_DENIED');
    expect((await execution.execute({ kind: 'file', input: { operation: 'write', path: file, content: 'changed' }, approvalId: 'a', fileGrants: grants })).errorCode).toBe('FILE_PATH_DENIED');
    expect(await readFile(file, 'utf8')).toBe('hello-grant');
    const approvalId = `grant-${task.id}`;
    const throughTool = await new ToolService().execute({ name: 'execute_file', arguments: { operation: 'list', path: dir } }, { source: 'agent', approvalId, conversationId: 'grant-test' });
    expect(throughTool.success).toBe(true);
    expect(JSON.stringify(throughTool.data)).toContain('note.html');
    await prisma.changeRecord.deleteMany({ where: { entityId: approvalId } });
  });

  it('does not list a shallow directory, a deleted citation, or a symlink that leaves the directory', async () => {
    const root = await tempDir();
    const dir = join(root, 'linked');
    await mkdir(dir);
    const inside = join(dir, 'kept.txt');
    const outside = join(root, 'outside.txt');
    await writeFile(inside, 'kept');
    await writeFile(outside, 'outside');
    let leak = join(dir, 'leak.txt');
    try { await symlink(outside, leak); } catch (error: any) {
      if (process.platform === 'win32' && error?.code === 'EPERM') leak = '';
      else throw error;
    }
    const folder = await prisma.task.create({ data: { title: '可列目录', description: dir } });
    const homeTask = await prisma.task.create({ data: { title: '家目录', description: homedir() } });
    const removed = await prisma.task.create({ data: { title: '已删除路径', description: outside, deletedAt: new Date().toISOString() } });
    createdTasks.push(folder.id, homeTask.id, removed.id);
    let shallow = '';
    let shallowFile = '';
    if (process.platform !== 'win32') {
      shallow = join('/tmp', `wwa-shallow-${Date.now()}`);
      shallowFile = join(shallow, 'note.txt');
      createdDirs.push(shallow);
      await mkdir(shallow, { recursive: true });
      await writeFile(shallowFile, 'shallow-file');
      const cited = await prisma.task.create({ data: { title: '浅目录文件', description: shallowFile } });
      createdTasks.push(cited.id);
    }

    const grants = await taskFileGrants();
    expect(grants.directories).toContain(dir);
    expect(grants.directories).not.toContain(homedir());
    expect(grants.files).not.toContain(outside);
    const execution = new ControlledExecutionAdapter();
    expect((await execution.execute({ kind: 'file', input: { operation: 'read', path: inside }, approvalId: 'a', fileGrants: grants })).data).toMatchObject({ content: 'kept' });
    if (shallowFile) {
      expect(grants.files).toContain(shallowFile);
      expect(grants.directories).not.toContain(shallow);
      expect((await execution.execute({ kind: 'file', input: { operation: 'read', path: shallowFile }, approvalId: 'a', fileGrants: grants })).data).toMatchObject({ content: 'shallow-file' });
      expect((await execution.execute({ kind: 'file', input: { operation: 'list', path: shallow }, approvalId: 'a', fileGrants: grants })).errorCode).toBe('FILE_PATH_DENIED');
    }
    if (leak) expect((await execution.execute({ kind: 'file', input: { operation: 'read', path: leak }, approvalId: 'a', fileGrants: grants })).errorCode).toBe('FILE_PATH_DENIED');
  });

  it('refuses an uncited absolute path before approval and lists the workspace', async () => {
    const tools = new ToolService();
    expect(await tools.fileAccessDenial({ operation: 'read', path: '/etc/passwd' })).toMatchObject({ code: 'FILE_PATH_DENIED' });
    expect(await tools.fileAccessDenial({ operation: 'explode', path: '.' })).toMatchObject({ code: 'FILE_OPERATION_DENIED' });
    expect(await tools.fileAccessDenial({ operation: 'list', path: '.' })).toBeNull();
    const listed = await new ControlledExecutionAdapter().execute({ kind: 'file', input: { operation: 'list', path: '.' }, approvalId: 'a' });
    expect(listed.success).toBe(true);
    expect(listed.data).toEqual(expect.objectContaining({ operation: 'list', entries: expect.any(Array) }));
    expect(formatSystemPrompt({}, [])).toContain('file://');
  });

  it('recognizes file urls and keeps shallow directories closed', () => {
    const cited = pathsInText('file:///Users/byc/WorkSpace/AfterSend/.archify/workflow-x/note.html。 https://example.com/a /tmp/also.txt');
    expect(cited).toContain('/Users/byc/WorkSpace/AfterSend/.archify/workflow-x/note.html');
    expect(cited).toContain('/tmp/also.txt');
    expect(cited.some((path) => path.startsWith('http'))).toBe(false);
    expect(isBroadDirectory('/Users/byc/WorkSpace')).toBe(true);
    expect(isBroadDirectory('/Users/byc')).toBe(true);
    expect(isBroadDirectory(homedir())).toBe(true);
    expect(isBroadDirectory('/Users/byc/WorkSpace/AfterSend/.archify/workflow-x')).toBe(false);
  });
});

