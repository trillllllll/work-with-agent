/** Visual count only. The node stays empty so button text and the accessible name stay the label. */
export function NavCount({ count }: { count?: number }) {
  if (!count || count <= 0) return null;
  const text = count > 99 ? '99+' : String(count);
  return <span className="nav-count" data-count={text} aria-hidden="true" />;
}
