export function BrandMark() {
  return (
    <div className="flex min-w-0 items-center gap-2" aria-label="WWA">
      <span className="sidebar-brand-mark" aria-hidden="true">
        <svg viewBox="0 0 32 32" className="size-3.5" fill="none">
          <path d="M4.5 9.5 9 22.5 15.8 10 22.6 22.5 27.5 9.5" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M7.2 8.5 11.6 19 16 11.8 20.4 19 24.8 8.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" opacity=".48" />
        </svg>
      </span>
      <strong className="truncate text-[13px] font-semibold leading-none">WWA</strong>
    </div>
  );
}
