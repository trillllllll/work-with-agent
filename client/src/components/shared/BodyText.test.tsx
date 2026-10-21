import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BodyText, textFormatForMaterial } from './BodyText.js';

describe('BodyText', () => {
  it('renders markdown through the gfm pipeline', () => {
    const html = renderToStaticMarkup(<BodyText text={'| a | b |\n| - | - |\n| 1 | 2 |'} format="markdown" />);
    expect(html).toContain('<td ');
    expect(html).toContain('>1</td>');
    expect(html).toContain('markdown-body');
    expect(html).toContain('text-sm');
  });

  it('renders plain text as a wrapped paragraph without markdown markup', () => {
    const html = renderToStaticMarkup(<BodyText text={'**not bold**\nsecond line'} />);
    expect(html).toContain('whitespace-pre-wrap');
    expect(html).toContain('break-words');
    expect(html).toContain('**not bold**');
    expect(html).not.toContain('<td>');
  });

  it('falls back to plain when markdown text is blank', () => {
    const html = renderToStaticMarkup(<BodyText text={'   \n\t'} format="markdown" />);
    expect(html).not.toContain('markdown-body');
    expect(html).toContain('whitespace-pre-wrap');
  });

  it('renders mono plain text as preformatted code', () => {
    const html = renderToStaticMarkup(<BodyText text={'{"a":1}'} mono />);
    expect(html.startsWith('<pre')).toBe(true);
    expect(html).toContain('font-mono');
  });

  it('passes className through to the markdown wrapper', () => {
    const html = renderToStaticMarkup(<BodyText text="# hi" format="markdown" className="overflow-auto" />);
    expect(html).toContain('markdown-body');
    expect(html).toContain('overflow-auto');
  });
});

describe('textFormatForMaterial', () => {
  it('treats markdown and thread kinds as markdown', () => {
    expect(textFormatForMaterial('markdown')).toBe('markdown');
    expect(textFormatForMaterial('thread')).toBe('markdown');
  });

  it('treats markdown mime as markdown and everything else as plain', () => {
    expect(textFormatForMaterial('text', 'text/markdown')).toBe('markdown');
    expect(textFormatForMaterial('text', 'text/plain')).toBe('plain');
    expect(textFormatForMaterial('attachment', 'application/pdf')).toBe('plain');
    expect(textFormatForMaterial('text')).toBe('plain');
  });
});
