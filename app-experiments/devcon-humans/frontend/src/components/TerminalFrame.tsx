import Link from "next/link";
import { SwitchBadge } from "./SwitchBadge";

/**
 * The search and profile pages: the rain scene far behind, one link top left and the
 * account (email, sign out) beside it, at the right; on a phone the account drops to a row
 * under the link, which lines up with the rain toggle (top right, fixed, from the layout).
 */
export function TerminalFrame({
  email,
  link,
  children,
}: {
  email: string;
  link: { href: string; label: string };
  children: React.ReactNode;
}) {
  return (
    <div className="terminal-page relative min-h-dvh">
      <div aria-hidden className="terminal-backdrop" />
      <div className="relative z-10 mx-auto flex min-h-dvh max-w-3xl flex-col px-4 sm:px-8">
        <header className="flex flex-col gap-1 pt-5 pb-6 pr-16 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:pr-0">
          <div className="flex min-h-11 shrink-0 items-center">
            <Link
              href={link.href}
              className="terminal-text text-lg leading-none transition-[filter] duration-300 hover:brightness-125 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#5dff8f]/60 sm:text-xl"
            >
              &gt; {link.label}
            </Link>
          </div>
          <div className="terminal-text flex min-w-0 items-baseline gap-3 text-sm leading-none sm:text-base">
            {email && (
              <>
                <span className="min-w-0 truncate opacity-60">{email}</span>
                <span aria-hidden className="opacity-30">
                  ·
                </span>
              </>
            )}
            <SwitchBadge className="shrink-0 whitespace-nowrap opacity-80 transition-opacity duration-300 hover:opacity-100 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#5dff8f]/60" />
          </div>
        </header>
        <main className="flex flex-1 flex-col pb-16">{children}</main>
      </div>
    </div>
  );
}
