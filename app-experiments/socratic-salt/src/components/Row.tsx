import Link from "next/link";
import type { ReactNode } from "react";

/** A row in a list, as frontend/ draws its agents. */
export function Row({ href, title, detail, aside }: { href: string; title: string; detail?: string; aside?: ReactNode }) {
  return (
    <Link
      href={href}
      className="bg-canvas-soft hover:bg-canvas-soft/60 group flex min-h-17 items-center gap-3 rounded-2xl px-5 py-4 transition"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-base leading-[1.38] font-semibold">{title}</span>
        {detail && <span className="text-muted mt-0.5 line-clamp-2 block text-xs leading-[1.43]">{detail}</span>}
      </span>
      {aside}
      <span className="text-muted shrink-0 transition-transform group-hover:translate-x-0.5">›</span>
    </Link>
  );
}
