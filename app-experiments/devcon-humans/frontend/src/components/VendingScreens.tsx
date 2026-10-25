"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSyncExternalStore } from "react";
import { parseProfile, saveProfile, storedProfile, subscribeProfile } from "@/lib/profile";
import InkDialog from "./InkDialog";
import { SignInPanel } from "./SignInPanel";

/**
 * Green terminal text on the vending machine's two screens, laid over the scene.
 *
 * The box matches where CyberScene composites the machine: bottom-anchored, centred, its
 * height `machineHeight * 0.6` of the viewport (0.78 * 0.6 = 46.8% by default) and the
 * image's own aspect (581 × 1163). The screens are placed by their glass in that image.
 *
 * The big screen reads "Enter" and opens the sign-in dialog, which leads to search once the
 * user's agent is set up; signed in already, it goes straight to search, except in admin mode,
 * where it opens the dialog again to switch users.
 * The small one shows "Profile found" and the email while this browser is signed in, and
 * opens the profile page.
 */
export function VendingScreens({ signedIn, admin }: { signedIn: boolean; admin: boolean }) {
  const router = useRouter();
  // The cookie is what signs a browser in: a profile left after it has gone is not shown, and the
  // next sign-in replaces it. (Clearing it here would also wipe the one just saved, before the
  // refreshed page knows of the new cookie.)
  const raw = useSyncExternalStore(subscribeProfile, storedProfile, () => null);
  const found = signedIn ? parseProfile(raw) : null;

  const enter = (
    <span className="terminal-text text-[24cqw] leading-none">
      ENTER<span className="terminal-cursor" aria-hidden />
    </span>
  );

  return (
    <div className="pointer-events-none absolute bottom-0 left-1/2 z-10 aspect-[581/1163] h-[46.8%] -translate-x-1/2">
      {/* Big screen. */}
      <div className="absolute left-[21.5%] top-[8.6%] h-[20.6%] w-[49.1%]">
        {/* Always this dialog, signed in or not, so the refresh after signing in cannot unmount it mid-close. */}
        <InkDialog
          label="Enter"
          trigger={(open) => (
            <button
              type="button"
              onClick={found && !admin ? () => router.push("/search") : open}
              aria-label="Enter"
              className="terminal-screen pointer-events-auto"
            >
              {enter}
            </button>
          )}
        >
          {() => (
            <SignInPanel
              admin={admin}
              onSignedIn={(p) => {
                saveProfile(p);
                router.push("/search");
              }}
            />
          )}
        </InkDialog>
      </div>

      {/* Small screen. */}
      <div className="absolute left-[23.2%] top-[38.7%] h-[12%] w-[29.3%]">
        <div className="terminal-screen" aria-live="polite">
          {found && (
            <Link
              href="/profile"
              aria-label="Your profile"
              className="pointer-events-auto flex h-full w-full flex-col items-start justify-center gap-[4cqw] px-[7cqw] transition-[filter] duration-300 hover:brightness-125"
            >
              <span className="terminal-text text-[12cqw] leading-none">PROFILE FOUND</span>
              <span className="terminal-text w-full truncate text-[8cqw] leading-none opacity-80">{found.email}</span>
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
