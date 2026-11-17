/**
 * These take undefined because the browser and the deployed Worker can be running
 * different versions of the usage shape, and a missing field should render as a dash
 * rather than crash the page.
 */
export function formatUsd(n: number | null | undefined): string {
  if (n == null) return "—";
  if (!n) return "$0";
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  if (n >= 0.000001) return `$${n.toFixed(6)}`;
  return `$${n.toExponential(2)}`;
}

export function formatMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function formatCount(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString("en-US");
}

/** Session creation date, as the header shows it: "12 Mar 2026, 4:05 PM". */
export function formatDate(ms: number | null | undefined): string {
  if (ms == null) return "—";
  return new Date(ms).toLocaleString("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Money as a person reads it, for a figure that sits in a fixed-width slot: two
 * decimals, thousands separated, and anything above zero but below a cent shown as
 * `<$0.01` rather than rounded down to nothing.
 *
 * Different from `formatUsd`, which is for a single turn's cost and shows six
 * decimals because a turn really can cost $0.000004. A running total wants to line
 * up in a column instead, and "$0.000004" in a header is four characters of noise
 * and one of information.
 */
export function formatUsdShort(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "$0.00";
  if (n <= 0) return "$0.00";
  // Under a cent, two decimals would read as nothing spent at all. Four is still a
  // fixed width, and it is the difference between "free" and "cheap".
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * A count that has to fit whatever it is given: exact up to four figures, then
 * abbreviated, so a long-running session cannot widen the header it sits in.
 */
export function formatCountShort(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "0";
  if (n < 10_000) return n.toLocaleString("en-US");
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 100_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}m`;
}

/**
 * A past day relative to today: "today", "yesterday", "3 days ago" within a week, then
 * the date ("12 Nov 26").
 */
export function formatDaysAgo(ms: number): string {
  const day = (t: number) => {
    const d = new Date(t);
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000;
  };
  const days = day(Date.now()) - day(ms);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return `on ${new Date(ms).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "2-digit",
  })}`;
}
