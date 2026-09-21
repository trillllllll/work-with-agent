export function BrandMark() {
  return (
    <div className="flex min-w-0 items-center gap-3" aria-label="WWA，专注，让更多可能发生">
      <span className="sidebar-brand-mark grid size-10 shrink-0 place-items-center rounded-[13px] bg-foreground text-background shadow-sm" aria-hidden="true">
        <svg viewBox="0 0 32 32" className="size-6" fill="none">
          <path d="M4.5 9.5 9 22.5 15.8 10 22.6 22.5 27.5 9.5" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M7.2 8.5 11.6 19 16 11.8 20.4 19 24.8 8.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" opacity=".48" />
        </svg>
      </span>
      <span className="min-w-0">
        <strong className="block truncate text-[15px] font-semibold tracking-[0.12em]">WWA</strong>
        <small className="mt-0.5 block truncate text-[10px] text-muted-foreground">专注，让更多可能发生</small>
      </span>
    </div>
  );
}
