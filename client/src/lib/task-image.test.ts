import { describe, expect, it } from 'vitest';
import { compressTaskImage, downscaleSteps, imageMime, isRasterImage } from './task-image.js';

describe('compressTaskImage', () => {
  it('rejects files that are not a still image', async () => {
    const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg"></svg>'], '图标.svg', { type: 'image/svg+xml' });
    expect(isRasterImage(svg)).toBe(false);
    await expect(compressTaskImage(svg)).rejects.toThrow('只支持图片');
    await expect(compressTaskImage(new File(['hello'], '笔记.txt', { type: 'text/plain' }))).rejects.toThrow('只支持图片');
  });

  it('halves oversized images before the final 2560 edge', () => {
    expect(downscaleSteps(1800, 1000)).toEqual([]);
    expect(downscaleSteps(3000, 1500)).toEqual([{ width: 2560, height: 1280 }]);
    expect(downscaleSteps(8000, 4000)).toEqual([{ width: 4000, height: 2000 }, { width: 2560, height: 1280 }]);
  });

  it('names only real WebP and JPEG bytes', () => {
    expect(imageMime(Uint8Array.of(0xff, 0xd8, 0xff, 0xdb))).toBe('image/jpeg');
    const webp = Uint8Array.of(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50);
    expect(imageMime(webp)).toBe('image/webp');
    expect(imageMime(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBeNull();
    expect(imageMime(Uint8Array.of(0xff, 0xd8))).toBeNull();
  });
});
