import { describe, expect, it } from 'vitest';
import { markdownAssetPaths, relativeAssetPath, resolveBatchAsset } from './markdown-assets.js';

describe('Markdown import resource aliases', () => {
  it('reads actual image/link definitions while preserving all source bytes', () => {
    const source = '\ufeff# Heading\r\n![Screenshot](./img/a%20b.png)\r\n[reference][file]\r\n\r\n[file]: ../files/proof.pdf\r\n\r\n`![not](code.png)`\r\n![remote](https://example.com/a.png)';
    expect(markdownAssetPaths(source).sort()).toEqual(['../files/proof.pdf', 'img/a b.png']);
    expect(source.startsWith('\ufeff# Heading\r\n')).toBe(true);
  });
  it('resolves only within the explicitly selected batch', () => {
    expect(resolveBatchAsset('docs/plan.md', '../img/a.png')).toBe('img/a.png');
    expect(resolveBatchAsset('plan.md', '../outside.png')).toBeNull();
    expect(relativeAssetPath('a/../b.png#view')).toBe('b.png');
    for (const path of ['file:///private/a', '/tmp/a', '\\host\\a', '%2fetc/passwd', 'data:image/png,xx', '%00a']) expect(relativeAssetPath(path)).toBeNull();
  });
});
