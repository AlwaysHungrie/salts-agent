import Link from "next/link";

/**
 * The search and profile pages: the rain scene far behind, the signed-in email and one
 * link top left (the rain toggle sits top right, fixed, from the layout).
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
        <header className="flex min-h-11 flex-col justify-center py-5 pr-16 sm:py-6">
          {email && <p className="terminal-text truncate text-base leading-none opacity-70">{email}</p>}
          <Link
            href={link.href}
            className="terminal-text mt-1.5 w-fit text-xl leading-none transition-[filter] duration-300 hover:brightness-125 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#5dff8f]/60"
          >
            &gt; {link.label}
          </Link>
        </header>
        <main className="flex flex-1 flex-col pb-16">{children}</main>
      </div>
    </div>
  );
}
