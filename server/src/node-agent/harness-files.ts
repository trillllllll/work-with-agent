import { constants } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { CodexRejected } from './harness-codex.js';
import { assertAllowed } from './git.js';
import { HARNESS_ATTACHMENT_TEXT_PREFIX, HARNESS_IMAGE_FILE_LIMIT, HARNESS_PREVIEW_FILE_LIMIT, type HarnessFilesPage, type HarnessInputAttachment } from './harness-protocol.js';

function imageType(bytes: Buffer) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return 'image/jpeg';
  return null;
}

export async function harnessFilePath(cwd: string, path: string) {
  if (isAbsolute(path) || path.split(/[\\/]/).includes('..') || path.includes('\0')) throw new CodexRejected('请选择会话所在项目内的文件');
  return assertAllowed(resolve(cwd, path), [cwd]);
}

export async function readHarnessFiles(cwd: string, path: string, preview: boolean): Promise<HarnessFilesPage> {
  const target = await harnessFilePath(cwd, path);
  const projectPath = relative(cwd, target);
  const info = await stat(target);
  if (!preview && info.isDirectory()) {
    const entries = (await readdir(target, { withFileTypes: true })).filter((item) => item.isDirectory() || item.isFile())
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    return {
      kind: 'directory', path: projectPath,
      entries: entries.slice(0, 200).map((item) => ({ name: item.name, directory: item.isDirectory(), path: relative(cwd, resolve(target, item.name)) })),
      limited: entries.length > 200,
    };
  }
  if (!info.isFile() || info.size > HARNESS_PREVIEW_FILE_LIMIT) throw new CodexRejected('只可预览 256 KB 以内的文本、PNG 和 JPEG 文件');
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw new CodexRejected('此路径不是可预览文件');
    const buffer = Buffer.alloc(HARNESS_PREVIEW_FILE_LIMIT + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > HARNESS_PREVIEW_FILE_LIMIT) throw new CodexRejected('文件预览大小超过 256 KB');
    const bytes = buffer.subarray(0, offset);
    const mediaType = imageType(bytes);
    if (mediaType) return { kind: 'file', path: projectPath, content: bytes.toString('base64'), mediaType };
    try {
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (content.includes('\0')) throw new Error('binary');
      return { kind: 'file', path: projectPath, content, mediaType: 'text/plain' };
    } catch {
      throw new CodexRejected('此文件无法预览');
    }
  } finally { await file.close(); }
}

export async function codexInput(cwd: string, value: string, files: HarnessInputAttachment[] = []) {
  const input: Array<{ type: 'text'; text: string } | { type: 'image'; url: string }> = [{ type: 'text', text: value }];
  for (const attachment of files) {
    const name = attachment.name.replace(/[\r\n\x00]/g, ' ').trim() || '附件';
    const header = HARNESS_ATTACHMENT_TEXT_PREFIX + name;
    if (attachment.kind === 'projectFile') {
      const path = await harnessFilePath(cwd, attachment.path);
      if (!(await stat(path)).isFile()) throw new CodexRejected('引用路径不是项目文件');
      input.push({ type: 'text', text: header + '\n工作区相对路径：' + relative(cwd, path) });
    } else if (attachment.kind === 'imageFile') {
      const bytes = Buffer.from(attachment.content, 'base64');
      if (bytes.length > HARNESS_IMAGE_FILE_LIMIT || imageType(bytes) !== attachment.mediaType) throw new CodexRejected('图片格式无效');
      input.push({ type: 'text', text: header }, { type: 'image', url: 'data:' + attachment.mediaType + ';base64,' + bytes.toString('base64') });
    } else {
      if (attachment.content.includes('\0')) throw new CodexRejected('附件不是有效文本');
      input.push({ type: 'text', text: header + '\n附件内容：\n' + attachment.content });
    }
  }
  return input;
}
