export function HBarList({ rows }: { rows: { id: string; label: string; value: number; color: string; meta?: string; onClick?: () => void }[] }) {
  const max = Math.max(1, ...rows.map((row) => row.value));
  if (rows.length === 0) return null;
  return (
    <ul className="space-y-2.5">
      {rows.map((row) => {
        const label = (
          <>
            <span className="flex min-w-0 items-center gap-2">
              <span className="size-2 shrink-0 rounded-full" style={{ background: row.color }} />
              <span className="truncate">{row.label}</span>
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">{row.meta ?? row.value}</span>
          </>
        );
        return (
          <li key={row.id} className="space-y-1">
            {row.onClick ? (
              <button type="button" className="flex w-full items-center justify-between gap-2 text-left text-sm" onClick={row.onClick}>{label}</button>
            ) : (
              <div className="flex items-center justify-between gap-2 text-sm">{label}</div>
            )}
            <div className="h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--muted)' }}>
              <div className="h-full rounded-full" style={{ width: `${Math.min(100, (row.value / max) * 100)}%`, background: row.color }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
