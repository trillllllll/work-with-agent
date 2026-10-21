const tags: Record<string, string> = {
  violet: 'var(--tag-violet-fg)',
  blue: 'var(--tag-blue-fg)',
  teal: 'var(--tag-teal-fg)',
  green: 'var(--tag-green-fg)',
  amber: 'var(--tag-amber-fg)',
  rose: 'var(--tag-rose-fg)',
  slate: 'var(--tag-slate-fg)',
};

const bands: Record<string, string> = {
  blue: 'var(--time-band-blue-fg)',
  green: 'var(--time-band-green-fg)',
  orange: 'var(--time-band-orange-fg)',
  purple: 'var(--time-band-purple-fg)',
  pink: 'var(--time-band-pink-fg)',
  gray: 'var(--time-band-gray-fg)',
};

export function tagColor(color: string | null | undefined): string {
  return tags[color ?? ''] ?? tags.slate;
}

export function bandColor(color: string | null | undefined): string {
  return bands[color ?? ''] ?? tags.slate;
}
