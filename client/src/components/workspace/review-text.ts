export function reviewPreview(text: string, limit = 200) {
  const chars = Array.from(text);
  return { long: chars.length > limit, preview: chars.slice(0, limit).join('') };
}
