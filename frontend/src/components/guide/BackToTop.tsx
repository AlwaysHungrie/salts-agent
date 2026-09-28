"use client";

/** Scrolls the page being read back to its top. The only way back to the app is the logo. */
export function BackToTop() {
  return (
    <button
      type="button"
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      className="text-muted hover:text-ink hidden cursor-pointer text-sm font-semibold transition-colors sm:block"
    >
      Back to top
    </button>
  );
}
