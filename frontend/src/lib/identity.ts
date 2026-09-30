"use client";

import { useCallback } from "react";
import { useAuth, useClerk, useUser } from "@clerk/nextjs";

/**
 * Who the browser is signed in as. Clerk is the only identity: the Next server forwards
 * the session token to the Worker, which verifies it, so the browser never holds it.
 */

export type Identity = {
  /** False until Clerk has loaded; nothing should be drawn before it. */
  ready: boolean;
  /** The address in play, lowercased, or "" when nobody is signed in. */
  email: string;
  signedIn: boolean;
  /** Ends the Clerk session. */
  signOut: () => void;
};

/** The one hook every surface asks "who is this". */
export function useIdentity(): Identity {
  const { isLoaded, isSignedIn } = useAuth();
  const { user } = useUser();
  const { signOut: clerkSignOut } = useClerk();

  const signOut = useCallback(() => {
    void clerkSignOut();
  }, [clerkSignOut]);

  return {
    ready: isLoaded,
    email: (user?.primaryEmailAddress?.emailAddress ?? "").trim().toLowerCase(),
    signedIn: !!isSignedIn,
    signOut,
  };
}
