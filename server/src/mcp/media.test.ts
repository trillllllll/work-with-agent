import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION,
  attachmentFileName,
  extractTaskImageRefs,
  guessMimeFromFileName,
  isTextLikeAttachment,
  prepareImage,
  resolveAttachmentMime,
} from './media.js';

describe('task image references', () => {
  it('keeps first-seen order, accepts an origin prefix, and ignores other tasks', () => {
    const description = [
      '![a](/api/tasks/task_1/images/img-b)',
      '![b](https://cdn.example.com/api/tasks/task_1/images/img-a)',
      '![c](/api/tasks/task_1/images/img-b)',
      '![d](/api/tasks/other/images/img-secret)',
      '![e](http://127.0.0.1:3016/api/tasks/task_1/images/img-c)',
      'plain /api/tasks/task_1/images/img-a again',
    ].join('\n');
    expect(extractTaskImageRefs('task_1', description)).toEqual(['img-b', 'img-a', 'img-c']);
    expect(extractTaskImageRefs('a.b+c', '![x](/api/tasks/a.b+c/images/img1) ![y](/api/tasks/aXb+c/images/nope)')).toEqual(['img1']);
    expect(extractTaskImageRefs('task_1', '')).toEqual([]);
    expect(extractTaskImageRefs('task_1', null)).toEqual([]);
  });
});

describe('prepareImage', () => {
  it('returns a small image unchanged', async () => {
    const small = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
    expect(small.byteLength).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
    const prepared = await prepareImage(small, 'image/png');
    expect(prepared).toMatchObject({ ok: true, mimeType: 'image/png', resized: false, byteSize: small.byteLength });
    if (!prepared.ok) return;
    expect(Buffer.from(prepared.data, 'base64')).toEqual(small);
  });

  it('downscales a wide image to a jpeg within the longest-side limit', async () => {
    const wide = await sharp({ create: { width: 2400, height: 12, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer();
    expect(wide.byteLength).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
    const prepared = await prepareImage(wide, 'image/png');
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.resized).toBe(true);
    expect(prepared.mimeType).toBe('image/jpeg');
    expect(prepared.byteSize).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
    const meta = await sharp(Buffer.from(prepared.data, 'base64')).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(MAX_IMAGE_DIMENSION);
    expect(meta.width).toBeGreaterThan(0);
  });

  it('re-encodes when the byte size exceeds the limit', async () => {
    const small = await sharp({ create: { width: 24, height: 24, channels: 3, background: { r: 1, g: 2, b: 3 } } }).jpeg().toBuffer();
    const padded = Buffer.concat([small, Buffer.alloc(MAX_IMAGE_BYTES)]);
    const prepared = await prepareImage(padded, 'image/jpeg');
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.resized).toBe(true);
    expect(prepared.mimeType).toBe('image/jpeg');
    expect(prepared.byteSize).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
  });

  it('returns a skipped reason when the bytes are not an image', async () => {
    const prepared = await prepareImage(Buffer.from('this is not an image'), 'image/png');
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.reason).toMatch(/decode|sharp|skipped/i);
  });
});

describe('attachment mime helpers', () => {
  it('reads the extended filename and falls back from octet-stream', () => {
    expect(attachmentFileName(`attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent('说明.md')}`)).toBe('说明.md');
    expect(resolveAttachmentMime('application/octet-stream', '说明.md')).toBe('text/markdown');
    expect(resolveAttachmentMime('image/png', 'notes.txt')).toBe('image/png');
    expect(guessMimeFromFileName('shot.jpeg')).toBe('image/jpeg');
    expect(isTextLikeAttachment('text/markdown', 'notes.md')).toBe(true);
    expect(isTextLikeAttachment('application/pdf', 'notes.pdf')).toBe(false);
  });
});
