export const codePoints = (value: string) => [...value].length;

export function boundedText(value: unknown, min: number, max: number, label: string) {
  if (typeof value !== 'string') return `${label}必须是文本`;
  const length = codePoints(value);
  if (length < min || length > max) return `${label}需要 ${min}～${max} 个字符`;
  return null;
}
