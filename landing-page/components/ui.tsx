import type { ReactNode } from "react";

export function Wrap({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`mx-auto w-full max-w-[1120px] px-6 ${className}`}>
      {children}
    </div>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="text-xs font-semibold uppercase tracking-[0.08em] text-faint">
      {children}
    </p>
  );
}

/** Stadium pill. Ink for the one action that matters, outline for the rest. */
export function Button({
  href,
  variant = "primary",
  size = "md",
  children,
}: {
  href: string;
  variant?: "primary" | "outline" | "invert";
  size?: "md" | "sm";
  children: ReactNode;
}) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-full font-semibold whitespace-nowrap transition-colors";
  const sizes = { md: "h-12 px-6 text-base", sm: "h-10 px-4 text-sm" };
  const variants = {
    primary: "bg-ink text-white hover:bg-ink-soft",
    outline: "bg-canvas text-ink ring-1 ring-hairline hover:bg-canvas-soft",
    invert: "bg-white text-ink hover:bg-canvas-soft",
  };

  return (
    <a href={href} className={`${base} ${sizes[size]} ${variants[variant]}`}>
      {children}
    </a>
  );
}

/**
 * A destination that may not exist yet. Real href renders a link; `null`
 * renders plain text, so the page never ships a `#` that goes nowhere.
 * Unbuilt destinations are listed in BROKEN-LINKS.md.
 */
export function MaybeLink({
  href,
  className = "",
  children,
}: {
  href: string | null;
  className?: string;
  children: ReactNode;
}) {
  if (!href) {
    return (
      <span className={className} aria-disabled="true">
        {children}
      </span>
    );
  }

  const external = href.startsWith("http");

  return (
    <a
      href={href}
      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
      className={className}
    >
      {children}
    </a>
  );
}

/** `text` with the first occurrence of `link.text` as an outbound link. */
export function LinkedText({
  text,
  link,
}: {
  text: string;
  link: { text: string; href: string };
}) {
  const at = text.indexOf(link.text);
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <a
        href={link.href}
        target="_blank"
        rel="noreferrer"
        className="text-ink underline decoration-hairline underline-offset-2 transition-colors hover:decoration-ink"
      >
        {link.text}
      </a>
      {text.slice(at + link.text.length)}
    </>
  );
}
