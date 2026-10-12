export function Highlighted({ text, start, end }: { text: string; start: number; end: number }) {
  const units = Array.from(text);
  const from = Math.max(0, Math.min(start, units.length));
  const to = Math.max(from, Math.min(end, units.length));
  return <>{units.slice(0, from).join('')}<mark>{units.slice(from, to).join('')}</mark>{units.slice(to).join('')}</>;
}
