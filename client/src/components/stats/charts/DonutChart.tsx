export function DonutChart({ segments, center, ariaLabel }: { segments: { id: string; value: number; color: string }[]; center: string; ariaLabel: string }) {
  const total = segments.reduce((sum, item) => sum + Math.max(0, item.value), 0);
  const radius = 32;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <svg role="group" aria-label={ariaLabel} viewBox="0 0 100 100" className="size-28 shrink-0">
      <circle cx="50" cy="50" r={radius} fill="none" stroke="var(--muted)" strokeWidth="12" />
      {total > 0 && segments.map((item) => {
        const value = Math.max(0, item.value);
        if (value <= 0) return null;
        const length = (value / total) * circumference;
        const node = (
          <circle
            key={item.id}
            cx="50"
            cy="50"
            r={radius}
            fill="none"
            stroke={item.color}
            strokeWidth="12"
            strokeDasharray={`${length} ${circumference - length}`}
            strokeDashoffset={-offset}
            transform="rotate(-90 50 50)"
          />
        );
        offset += length;
        return node;
      })}
      <text x="50" y="50" textAnchor="middle" dominantBaseline="middle" fill="var(--foreground)" fontSize="14" fontWeight="600">{center}</text>
    </svg>
  );
}
