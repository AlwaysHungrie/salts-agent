"use client";

import { useEffect, useRef, useState } from "react";
import { useUser } from "@clerk/nextjs";
import { useIdentity } from "@/lib/identity";

/**
 * The signed-in avatar and its one menu item.
 *
 * Clerk's own <UserButton> carries a profile manager, an org switcher and its
 * branding; none of that has a place here. This is the picture and a way out.
 *
 * An impersonated address has no Clerk user behind it and so no picture; it gets its
 * first letter on a plain disc, and logging out clears the two localStorage keys
 * rather than ending a session there was never one of.
 */
export function UserMenu() {
  const { user } = useUser();
  const { ready, mode, email, signedIn, signOut } = useIdentity();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  // A dropdown that outlives a click elsewhere is a bug, not a feature.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!ready || !signedIn) return null;

  const label = email || "Account";
  // Google accounts arrive with a picture; email sign-ups get Clerk's generated
  // initials image. An impersonated address has neither, so it gets a letter.
  const picture = mode === "clerk" ? user?.imageUrl : undefined;

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        className="ring-hairline hover:ring-ink block h-12 w-12 cursor-pointer overflow-hidden rounded-full ring-2 transition"
      >
        {picture ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={picture}
            alt=""
            width={56}
            height={5}
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="bg-field text-ink flex h-full w-full items-center justify-center text-base font-semibold uppercase">
            {label.slice(0, 1)}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="bg-canvas border-hairline-soft absolute right-0 z-50 mt-2 w-44 rounded-xl border"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              signOut();
            }}
            className="hover:bg-canvas-soft w-full cursor-pointer rounded-xl px-3 py-2 text-left text-sm leading-[1.43] transition"
          >
            Log out
          </button>
        </div>
      )}
    </div>
  );
}
