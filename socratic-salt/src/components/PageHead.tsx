import Link from "next/link";
import type { ReactNode } from "react";
import { Mark } from "./Mark";
import { UserMenu } from "./auth/UserMenu";

/** The head every non-chat page shares: mark, title, one line, and the account menu. */
export function PageHead({
  title,
  subtitle,
  back,
  signedIn = true,
  children,
}: {
  title: string;
  subtitle?: string;
  back?: { href: string; label: string };
  signedIn?: boolean;
  children?: ReactNode;
}) {
  return (
    <>
      {back && (
        <Link href={back.href} className="text-muted hover:text-ink mb-4 inline-block text-sm transition-colors">
          ← {back.label}
        </Link>
      )}
      <div className="border-canvas-soft flex items-center justify-between gap-4 border-b pb-4">
        <div className="flex min-w-0 items-center gap-3">
          <Link href="/" className="group shrink-0" aria-label="Home">
            <Mark />
          </Link>
          <div className="min-w-0">
            <h1 className="truncate text-[32px] leading-[1.2] font-[650]">{title}</h1>
            {subtitle && <p className="text-muted mt-1 text-sm leading-[1.43] font-light">{subtitle}</p>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {children}
          {signedIn && <UserMenu />}
        </div>
      </div>
    </>
  );
}

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

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="text-faint mt-8 mb-2 ml-1 text-xs font-semibold tracking-[0.08em] uppercase">{children}</h2>;
}
