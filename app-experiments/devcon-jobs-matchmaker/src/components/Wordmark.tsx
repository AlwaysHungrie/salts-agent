/** The product's mark: a badge tag beside the name. */
export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 font-display text-lg font-bold tracking-tight ${className}`}>
      <svg width="22" height="26" viewBox="0 0 22 26" aria-hidden>
        <rect x="1" y="4" width="20" height="21" rx="5" fill="currentColor" />
        <rect x="7" y="7.5" width="8" height="2.5" rx="1.25" fill="#eef1f7" />
        <rect x="8.5" y="0" width="5" height="6" rx="1.5" fill="#ffb020" />
      </svg>
      Devcon Jobs
    </span>
  );
}
