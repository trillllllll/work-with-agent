import { describe, it, expect } from 'vitest';
import { closedElements, htmlFragments, svgCandidate } from './streaming-markup.js';
describe('shared progressive markup contract', () => {
  it('holds incomplete quotes, comments, containers and scripts', () => {
    for (const rest of ['<section><p>x</p>', '<p title="a>b', '<!-- x', '<script>if(a<b){go()}']) {
      expect(closedElements('<p>ready</p>' + rest)).toEqual({ parts: ['<p>ready</p>'], rest });
    }
    expect(htmlFragments('<p>ready</p><script>window.count=1</script>')).toEqual({ parts: ['<p>ready</p>'] });
    expect(htmlFragments('<p>ready</p><script>window.count=1</script>', true).script).toBe('window.count=1');
  });
  it.each(['<html><body>x</body></html>', '<script src="https://cdn.jsdelivr.net/x@1/a.js"></script>', '<script type="module">x</script>', '<div><script>x</script></div>', '<p onclick="go()">x</p>', '<script>x</script><p>late</p>', '<script>a</script><script>b</script>', '<template><p>x</p></template>', '<p>x'])('rejects unsupported fragment structures: %s', source => {
    expect(() => htmlFragments(source, true)).toThrow();
  });
  it('takes only completed SVG children and preserves full final source', () => {
    const source = '<svg viewBox="0 0 20 20"><rect width="2"/><g><circle';
    expect(svgCandidate(source)).toBe('<svg viewBox="0 0 20 20"><rect width="2"/></svg>');
    expect(() => closedElements('<p></div>')).toThrow();
  });
});
it('preserves script bytes including HTML-comment-looking strings', () => {
  const script = 'document.querySelector("p").textContent="<!-- keep this text -->";';
  expect(htmlFragments('<p>ready</p><!-- outer --><script>' + script + '</script>', true).script).toBe(script);
});
